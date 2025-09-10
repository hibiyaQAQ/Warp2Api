/**
 * Deno Serverless Frontend for Warp2Api
 * 
 * 轻量级 OpenAI 兼容 API 代理，适用于 Deno Deploy、Vercel 等 Serverless 平台
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// 配置
const BRIDGE_BASE_URL = Deno.env.get("WARP_BRIDGE_URL") || "http://127.0.0.1:8000";
const PORT = parseInt(Deno.env.get("PORT") || "8010");

// UUID 生成函数
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 类型定义
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | any[];
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

// 日志函数
function log(level: "INFO" | "ERROR" | "WARN", message: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} [${level}] ${message}`, ...args);
}

// 健康检查
async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5秒超时
    });
    return response.ok;
  } catch (error) {
    log("WARN", "Bridge health check failed:", error.message);
    return false;
  }
}

// 获取模型列表
async function getModels(): Promise<Response> {
  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    log("INFO", "Successfully fetched models from backend");
    
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  } catch (error) {
    log("ERROR", "Failed to fetch models:", error.message);
    
    // Fallback 模型列表
    const fallbackModels: OpenAIModel[] = [
      {
        id: "auto",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "warp",
      },
      {
        id: "claude-4-sonnet",
        object: "model", 
        created: Math.floor(Date.now() / 1000),
        owned_by: "warp",
      },
      {
        id: "gpt-4o",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "warp",
      },
    ];
    
    return new Response(JSON.stringify({ object: "list", data: fallbackModels }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }
}

// 聊天完成
async function chatCompletions(request: Request): Promise<Response> {
  try {
    const body = await request.text();
    const chatRequest: ChatCompletionRequest = JSON.parse(body);
    
    log("INFO", "Processing chat completion request for model:", chatRequest.model);
    
    // 生成必要的 ID
    const taskId = generateUUID();
    const toolMessageId = generateUUID();
    const toolCallId = generateUUID();
    
    // 找到最后一个用户消息
    const lastUserMessage = chatRequest.messages
      .slice()
      .reverse()
      .find(msg => msg.role === "user");
    
    if (!lastUserMessage) {
      throw new Error("No user message found");
    }
    
    // ✅ 关键修复：只有服务器工具调用消息放在 task_context.tasks[0].messages 中
    // 历史消息处理逻辑需要重新实现，但对于简单情况，只放服务器消息
    const taskMessages = [
      // 服务器工具调用前导消息
      {
        id: toolMessageId,
        task_id: taskId,
        tool_call: {
          tool_call_id: toolCallId,
          server: { payload: "IgIQAQ==" },
        },
      }
    ];
    
    // TODO: 如果有多轮对话历史，需要正确处理，但现在先保持简单
    
    // 构造符合 Warp 协议的数据包
    const warpPacket = {
      task_context: {
        tasks: [{
          id: taskId,
          description: "",
          status: { in_progress: {} },
          messages: taskMessages,
        }],
        active_task_id: taskId,
      },
      input: {
        context: {},
        user_inputs: {
          inputs: [{
            user_query: {
              query: typeof lastUserMessage.content === "string"
                ? lastUserMessage.content
                : JSON.stringify(lastUserMessage.content)
            }
          }]
        }
      },
      settings: {
        model_config: {
          base: chatRequest.model || "claude-4.1-opus",
          planning: "gpt-5 (high reasoning)",
          coding: "auto",
        },
        rules_enabled: false,
        web_context_retrieval_enabled: false,
        supports_parallel_tool_calls: false,
        planning_enabled: false,
        warp_drive_context_enabled: false,
        supports_create_files: false,
        use_anthropic_text_editor_tools: false,
        supports_long_running_commands: false,
        should_preserve_file_content_in_history: false,
        supports_todos_ui: false,
        supports_linked_code_blocks: false,
        supported_tools: [9],
      },
      metadata: {
        logging: {
          is_autodetected_user_query: true,
          entrypoint: "USER_INITIATED"
        }
      },
    };
    
    // 根据请求类型选择端点
    if (chatRequest.stream) {
      // 流式响应：使用 SSE 端点并转换为 OpenAI 格式
      const response = await fetch(`${BRIDGE_BASE_URL}/api/warp/send_stream_sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({
          json_data: warpPacket,
          message_type: "warp.multi_agent.v1.Request"
        }),
        signal: AbortSignal.timeout(180000),
      });
      
      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
      }
      
      log("INFO", "Successfully connected to backend stream");
      
      // 创建 OpenAI 格式的 SSE 转换流
      const completionId = generateUUID();
      const createdTs = Math.floor(Date.now() / 1000);
      const modelId = chatRequest.model || "warp-default";
      
      const transformedStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          
          try {
            // 发送首个 OpenAI 格式的 chunk
            const firstChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created: createdTs,
              model: modelId,
              choices: [{ index: 0, delta: { role: "assistant" } }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
            
            if (response.body) {
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split('\n');
                  buffer = lines.pop() || "";
                  
                  for (const line of lines) {
                    if (line.startsWith('data:')) {
                      const payload = line.slice(5).trim();
                      if (!payload || payload === '[DONE]') continue;
                      
                      try {
                        const event = JSON.parse(payload);
                        const eventData = event?.parsed_data || {};
                        
                        // 处理 client_actions
                        const clientActions = eventData.client_actions || eventData.clientActions;
                        if (clientActions?.actions) {
                          for (const action of clientActions.actions) {
                            // 处理文本内容
                            const appendData = action.append_to_message_content || action.appendToMessageContent;
                            if (appendData?.message) {
                              const agentOutput = appendData.message.agent_output || appendData.message.agentOutput;
                              const textContent = agentOutput?.text;
                              if (textContent) {
                                const delta = {
                                  id: completionId,
                                  object: "chat.completion.chunk",
                                  created: createdTs,
                                  model: modelId,
                                  choices: [{ index: 0, delta: { content: textContent } }],
                                };
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
                              }
                            }
                          }
                        }
                      } catch (parseError) {
                        log("WARN", "Failed to parse SSE event:", parseError.message);
                      }
                    }
                  }
                }
              } finally {
                reader.releaseLock();
              }
              
              // 发送结束标记
              const finalChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created: createdTs,
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            }
            
            controller.close();
          } catch (error) {
            log("ERROR", "Stream transformation error:", error.message);
            controller.error(error);
          }
        }
      });
      
      return new Response(transformedStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    } else {
      // 非流式响应：使用普通端点
      const response = await fetch(`${BRIDGE_BASE_URL}/api/warp/send_stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          json_data: warpPacket,
          message_type: "warp.multi_agent.v1.Request"
        }),
        signal: AbortSignal.timeout(180000),
      });
      
      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
      }
      
      log("INFO", "Successfully got backend response");
      
      const result = await response.json();
      
      log("INFO", "Backend response structure:", JSON.stringify(result, null, 2).substring(0, 500));
      
      // ✅ 修复：按照 Python 前端的方式提取响应
      let content = "";
      let toolCalls = [];
      
      // 1. 首先尝试直接获取 response 字段（如 Python）
      if (result.response && typeof result.response === "string") {
        content = result.response;
      }
      
      // 2. 如果没有直接的 response，从 parsed_events 中提取
      if (!content && result.parsed_events) {
        for (const event of result.parsed_events) {
          const eventData = event.parsed_data || event.raw_data || {};
          const clientActions = eventData.client_actions || eventData.clientActions;
          if (clientActions?.actions) {
            for (const action of clientActions.actions) {
              // 提取工具调用
              const addMsgs = action.add_messages_to_task || action.addMessagesToTask;
              if (addMsgs?.messages) {
                for (const message of addMsgs.messages) {
                  const toolCall = message.tool_call || message.toolCall;
                  const callMcp = toolCall?.call_mcp_tool || toolCall?.callMcpTool;
                  if (callMcp?.name) {
                    toolCalls.push({
                      id: toolCall.tool_call_id || generateUUID(),
                      type: "function",
                      function: {
                        name: callMcp.name,
                        arguments: JSON.stringify(callMcp.args || {})
                      }
                    });
                  }
                }
              }
              
              // 提取文本内容
              const appendData = action.append_to_message_content || action.appendToMessageContent;
              if (appendData?.message) {
                const agentOutput = appendData.message.agent_output || appendData.message.agentOutput;
                const textContent = agentOutput?.text;
                if (textContent) {
                  content += textContent;
                }
              }
            }
          }
        }
      }
      
      // 3. 最后尝试从 events 中提取（兼容性）
      if (!content && result.events) {
        for (const event of result.events) {
          const eventData = event.parsed_data || {};
          const clientActions = eventData.client_actions || eventData.clientActions;
          if (clientActions?.actions) {
            for (const action of clientActions.actions) {
              const appendData = action.append_to_message_content || action.appendToMessageContent;
              if (appendData?.message) {
                const agentOutput = appendData.message.agent_output || appendData.message.agentOutput;
                const textContent = agentOutput?.text;
                if (textContent) {
                  content += textContent;
                }
              }
            }
          }
        }
      }
      
      // 返回 OpenAI 格式响应
      const completionId = generateUUID();
      const createdTs = Math.floor(Date.now() / 1000);
      const modelId = chatRequest.model || "warp-default";
      
      log("INFO", "Extracted content:", content.substring(0, 200));
      log("INFO", "Tool calls count:", toolCalls.length);
      
      const openaiResponse = {
        id: completionId,
        object: "chat.completion",
        created: createdTs,
        model: modelId,
        choices: [{
          index: 0,
          message: toolCalls.length > 0 ? {
            role: "assistant",
            content: "",
            tool_calls: toolCalls
          } : {
            role: "assistant",
            content: content || "I apologize, but I couldn't generate a response. Please try again."
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      return new Response(JSON.stringify(openaiResponse), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
    
  } catch (error) {
    log("ERROR", "Chat completion failed:", error.message);
    
    return new Response(JSON.stringify({
      error: {
        message: `Backend service unavailable: ${error.message}`,
        type: "service_unavailable",
        code: "backend_error"
      }
    }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

// CORS 预检请求处理
function handleCORS(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// 主处理函数
async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  
  log("INFO", `${method} ${url.pathname}`);
  
  // CORS 预检
  if (method === "OPTIONS") {
    return handleCORS();
  }
  
  try {
    // 路由处理
    if (url.pathname === "/" || url.pathname === "/healthz") {
      const isHealthy = await healthCheck();
      return new Response(JSON.stringify({
        service: "OpenAI Chat Completions (Warp bridge) - Serverless",
        status: isHealthy ? "ok" : "backend_unavailable",
        bridge_url: BRIDGE_BASE_URL,
        timestamp: new Date().toISOString(),
      }), {
        status: isHealthy ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    if (url.pathname === "/v1/models" && method === "GET") {
      return await getModels();
    }
    
    if (url.pathname === "/v1/chat/completions" && method === "POST") {
      return await chatCompletions(request);
    }
    
    // 404
    return new Response(JSON.stringify({
      error: {
        message: "Not found",
        type: "not_found",
      }
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    
  } catch (error) {
    log("ERROR", "Request handler error:", error.message);
    
    return new Response(JSON.stringify({
      error: {
        message: "Internal server error",
        type: "server_error",
      }
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 启动服务器
if (import.meta.main) {
  log("INFO", "Starting Deno Serverless Frontend");
  log("INFO", `Bridge URL: ${BRIDGE_BASE_URL}`);
  log("INFO", `Listening on port ${PORT}`);
  
  serve(handler, { port: PORT });
}

export default handler;