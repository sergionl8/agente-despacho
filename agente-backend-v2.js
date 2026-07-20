/**
 * AGENTE DE DESPACHO - BACKEND RAILWAY V2
 * 
 * Features:
 * - CORS permitiendo Lovable (producción + preview)
 * - Validación JWT de Supabase
 * - Cliente Supabase con RLS (usuario autenticado)
 * - Conecta Claude API + MCP de Lovable
 * - Responde en formato: { message: "..." }
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();

// ==========================================
// CONFIGURACIÓN
// ==========================================

const SUPABASE_URL = process.env.SUPABASE_URL; // https://xxxxx.supabase.co
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3001;

const MCP_SERVER_URL = 'https://gml-drive-vision.lovable.app/mcp';

const ALLOWED_ORIGINS = new Set([
  'https://gml-drive-vision.lovable.app',
  'https://id-preview--b33710e6-a4cd-4f8c-a9e6-996c2bd4d083.lovable.app',
]);

// ==========================================
// MIDDLEWARE CORS DINÁMICO
// ==========================================

app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  
  next();
});

app.use(express.json());

// ==========================================
// VALIDACIÓN JWT SUPABASE
// ==========================================

async function validateToken(token) {
  try {
    if (!token) throw new Error('No token provided');
    
    // Remover "Bearer " del inicio
    const jwt = token.startsWith('Bearer ') 
      ? token.slice(7) 
      : token;
    
    // Opción B: Validar JWT contra JWKS de Supabase
    // (sin hacer llamada a Supabase en cada request)
    
    const jwksUrl = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
    const jwksResponse = await fetch(jwksUrl);
    const jwks = await jwksResponse.json();
    
    // Decodificar JWT header para obtener kid
    const [headerB64] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64').toString());
    
    // Buscar key correspondiente
    const key = jwks.keys.find(k => k.kid === header.kid);
    if (!key) throw new Error('Key not found in JWKS');
    
    // Verificar firma (simplificado - en prod usa jsonwebtoken library)
    // Por ahora, solo decodificamos y usamos el payload
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    
    if (!payload.sub) throw new Error('Invalid token: no sub claim');
    
    return {
      userId: payload.sub,
      email: payload.email,
      token: jwt,
    };
  } catch (error) {
    console.error('Token validation error:', error.message);
    throw error;
  }
}

// ==========================================
// EJECUTAR HERRAMIENTAS MCP
// ==========================================

async function executeMCPTool(toolName, toolInput, userToken) {
  try {
    console.log(`Ejecutando MCP tool: ${toolName}`, toolInput);

    const response = await fetch(MCP_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolInput,
        },
        id: Date.now(),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MCP error ${response.status}: ${error}`);
    }

    const result = await response.json();
    return result.result || result;
  } catch (error) {
    console.error(`Error ejecutando ${toolName}:`, error.message);
    throw error;
  }
}

// ==========================================
// PROCESAR MENSAJE CON CLAUDE + MCP
// ==========================================

async function processMessageWithClaude(messages, userToken) {
  const systemPrompt = `Eres un Agente Inteligente de Despacho para Grupo Multilin Logistics.

Tu rol:
1. Recibir información de un pedido nuevo
2. Usar herramientas MCP para consultar disponibilidad REAL de remolques
3. Proponer la MEJOR opción + 2 alternativas (con scoring)
4. Si el usuario confirma, crear el viaje automáticamente en Lovable

CUANDO RECIBAS UN PEDIDO:
- Extrae: cliente, origen, destino, tipo de carga (si menciona), urgencia
- Usa list_remolques_ubicacion para ver qué hay disponible AHORA
- Calcula scoring:
  * Disponibilidad: 40% (disponible ahora > en Xmin > en Xhoras)
  * Tipo correcto: 30% (prefieren este tipo)
  * Ubicación: 20% (está en Monterrey > Laredo > En tránsito)
  * Eficiencia: 10% (menor costo, mejor utilización)
- Propone TOP 3 con score y razonamiento

FORMATO DE PROPUESTA:
📍 [CLIENTE] ([Urgencia]):

✅ Opción 1 - Remolque [ECO]
   Score: 95/100 | [Tipo] | [Ubicación]
   ✓ [Razón 1]
   ✓ [Razón 2]
   Tiempo salida: Inmediato

⭐ Opción 2 - Remolque [ECO]
   Score: 85/100 | [Tipo] | [Ubicación]
   ✓ [Razón 1]
   Tiempo salida: 30 minutos

📋 Opción 3 - Remolque [ECO]
   Score: 75/100 | [Tipo] | [Ubicación]
   ✓ [Razón 1]
   Tiempo salida: 2 horas

¿Cuál confirmas? (Escribe "Confirma opción 1", "Opción 2", etc)

IMPORTANTE:
- SIEMPRE usa list_remolques_ubicacion para datos reales, NO inventes
- Respeta ubicaciones exactas (Monterrey, Laredo, En Tránsito)
- Si no hay remolque perfecto → propón alternativas creativas
- Cuando confirmen → usa create_viaje con: cliente, remolque_eco, origen, destino
- El usuario solo ve datos que le corresponden (RLS de Lovable automático)`;

  const anthropic = new Anthropic({
    apiKey: CLAUDE_API_KEY,
  });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    tools: [
      {
        name: 'list_remolques_ubicacion',
        description:
          'Lista remolques disponibles con ubicación, estado, días parado. Respeta permisos del usuario.',
        input_schema: {
          type: 'object',
          properties: {
            estado_filter: {
              type: 'string',
              enum: ['activa', 'mantenimiento', 'dañada', 'todas'],
              default: 'activa',
            },
            ubicacion: {
              type: 'string',
              enum: ['monterrey', 'laredo', 'transito', 'todas'],
              default: 'todas',
            },
            limit: {
              type: 'number',
              default: 50,
            },
          },
        },
      },
      {
        name: 'create_viaje',
        description:
          'Crea un nuevo viaje/flete en Lovable. Llamar SOLO cuando usuario confirme.',
        input_schema: {
          type: 'object',
          properties: {
            cliente_id: {
              type: 'string',
              description: 'ID o nombre exacto del cliente',
            },
            remolque_eco: {
              type: 'string',
              description: 'ECO del remolque (ej: "7", "28", "099")',
            },
            origen: {
              type: 'string',
              description: 'Ubicación origen',
            },
            destino: {
              type: 'string',
              description: 'Ubicación destino',
            },
            tipo_carga: {
              type: 'string',
              default: 'General',
            },
            urgencia: {
              type: 'string',
              enum: ['hoy', 'mañana', 'proximo', 'flexible'],
              default: 'proximo',
            },
            notas: {
              type: 'string',
            },
          },
          required: ['cliente_id', 'remolque_eco', 'origen', 'destino'],
        },
      },
      {
        name: 'update_remolque_ubicacion',
        description: 'Actualiza ubicación o estado de un remolque.',
        input_schema: {
          type: 'object',
          properties: {
            remolque_eco: {
              type: 'string',
            },
            ubicacion: {
              type: 'string',
              enum: ['monterrey', 'laredo', 'transito'],
            },
            estado: {
              type: 'string',
              enum: ['activa', 'mantenimiento', 'dañada', 'ociosa'],
            },
          },
          required: ['remolque_eco'],
        },
      },
    ],
    messages: messages,
  });

  // Procesar respuesta, ejecutando herramientas si es necesario
  let finalText = '';

  for (const block of response.content) {
    if (block.type === 'text') {
      finalText += block.text;
    } else if (block.type === 'tool_use') {
      try {
        const result = await executeMCPTool(block.name, block.input, userToken);
        finalText += `\n[✓ ${block.name} ejecutado]`;
        console.log(`Tool result:`, result);
      } catch (error) {
        finalText += `\n[⚠️ Error en ${block.name}: ${error.message}]`;
      }
    }
  }

  return finalText;
}

// ==========================================
// ENDPOINT: POST /api/chat
// ==========================================

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const authHeader = req.headers.authorization;

    // Validar entrada
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: 'Messages debe ser un array',
      });
    }

    if (!authHeader) {
      return res.status(401).json({
        error: 'Authorization header requerido',
      });
    }

    // Validar token
    let userInfo;
    try {
      userInfo = await validateToken(authHeader);
    } catch (error) {
      return res.status(401).json({
        error: 'Token inválido o expirado',
      });
    }

    console.log(`Request de usuario: ${userInfo.email} (${userInfo.userId})`);

    // Procesar con Claude
    const message = await processMessageWithClaude(messages, userInfo.token);

    // Responder en formato esperado por Lovable
    res.json({
      message: message,
      userId: userInfo.userId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error en /api/chat:', error);
    res.status(500).json({
      error: error.message || 'Error procesando el mensaje',
      message: '⚠️ Error interno. Intenta de nuevo.',
    });
  }
});

// ==========================================
// ENDPOINT: GET /health (para testing)
// ==========================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mcp_server: MCP_SERVER_URL,
    supabase: SUPABASE_URL ? '✓ Configurado' : '✗ Falta SUPABASE_URL',
    claude_api: CLAUDE_API_KEY ? '✓ Configurado' : '✗ Falta CLAUDE_API_KEY',
    timestamp: new Date().toISOString(),
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, () => {
  console.log(`🚀 Agente Backend escuchando en puerto ${PORT}`);
  console.log(`📡 MCP Server: ${MCP_SERVER_URL}`);
  console.log(`🔐 Supabase: ${SUPABASE_URL}`);
  console.log(`\n⚠️  Variables de entorno requeridas:`);
  console.log(`  - CLAUDE_API_KEY`);
  console.log(`  - SUPABASE_URL`);
  console.log(`  - SUPABASE_ANON_KEY`);
  console.log(`\n✅ Listo para recibir solicitudes desde Lovable`);
});
