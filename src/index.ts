#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { OpenAPIV3, OpenAPIV2 } from "openapi-types";
import { compile } from "json-schema-to-typescript";

const DEFAULT_TIMEOUT_MS = 10_000;

function getVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") return pkg.version;
  } catch {
    // ignore
  }
  return "0.0.0";
}

const VERSION = getVersion();

// 定义 Swagger/OpenAPI 文档类型 (使用 openapi-types 的别名或扩展)
type SwaggerDocument = OpenAPIV3.Document | OpenAPIV2.Document;

const HTTP_METHOD_ORDER = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
] as const;

const HTTP_METHODS = new Set<string>(HTTP_METHOD_ORDER);

const UrlOnlyArgsSchema = z.object({
  url: z.string().url().describe("Swagger/OpenAPI 文档的完整 URL 地址"),
  use_fallback: z.boolean().optional().default(true).describe("是否在解析失败时使用降级策略（直接读取原始 JSON）"),
});

const ReadSwaggerApiArgsSchema = UrlOnlyArgsSchema.extend({
  path_pattern: z.string().optional().describe("可选：过滤关键词。支持搜索 URL、Summary 和 Description。"),
  tag: z.string().optional().describe("可选：按 Tag（模块/控制器）过滤接口。"),
  generate_ts: z.boolean().optional().default(true).describe("是否生成 TypeScript 类型定义"),
  generate_mock: z.boolean().optional().default(false).describe("是否生成 Mock 数据示例"),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("返回 JSON 的最大深度（越小越不易上下文爆炸）"),
  limit_paths: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .default(50)
    .describe("最多返回多少个 path（0 表示不限制）"),
  limit_ops: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .default(200)
    .describe("最多返回多少个 operation（0 表示不限制）"),
});

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

function extractParameterSchema(param: any): any | undefined {
  if (!param || typeof param !== "object") return undefined;
  if (param.schema) return param.schema;
  if (param.type) {
    const schema: any = { type: param.type };
    if (param.format) schema.format = param.format;
    if (param.items) schema.items = param.items;
    if (param.enum) schema.enum = param.enum;
    if (param.default !== undefined) schema.default = param.default;
    return schema;
  }
  return undefined;
}

function getOperations(pathItem: unknown): any[] {
  if (!pathItem || typeof pathItem !== "object") return [];
  return Object.entries(pathItem)
    .filter(([method, op]) => HTTP_METHODS.has(method) && op && typeof op === "object")
    .map(([, op]) => op);
}

function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return (Promise.race([promise, timeoutPromise]) as Promise<T>).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

// 2. 初始化 Server
const server = new Server(
  {
    name: "mcp-swagger-reader",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 3. 降级策略：直接读取原始 JSON (带超时控制)
// 3. 降级策略与核心解析逻辑

// 递归截断与循环引用处理
function sanitizeRecursive(obj: any, depth = 0, maxDepth = 3, seen = new WeakSet()): any {
  if (depth > maxDepth) return `[Truncated: >${maxDepth} levels]`;
  if (obj === null || typeof obj !== "object") return obj;
  
  if (seen.has(obj)) return "[Circular Ref]";
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeRecursive(item, depth + 1, maxDepth, seen));
  }

  const result: any = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = sanitizeRecursive(obj[key], depth + 1, maxDepth, seen);
    }
  }
  return result;
}

// 简单的 Mock 数据生成器
function generateMockData(schema: any): any {
  if (!schema) return null;
  if (schema.example) return schema.example;
  
  if (schema.type === "object") {
    const result: any = {};
    if (schema.properties) {
      for (const key in schema.properties) {
        result[key] = generateMockData(schema.properties[key]);
      }
    }
    return result;
  }
  
  if (schema.type === "array") {
    return [generateMockData(schema.items)];
  }
  
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2024-01-01T00:00:00Z";
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];
    return "string_value";
  }
  
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "boolean") return true;
  
  return null;
}

async function fetchRawSwagger(url: string): Promise<SwaggerDocument> {
  console.error(`[MCP] 使用降级策略：直接读取原始 JSON...`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: {
        "User-Agent": `MCP-Swagger-Reader/${VERSION}`,
        "Accept": "application/json, */*"
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().includes("json")) {
       const text = await response.text();
       throw new Error(`返回内容不是 JSON (Content-Type: ${contentType})。内容预览: ${text.substring(0, 100)}...`);
    }

    return await response.json() as SwaggerDocument;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getSwaggerApi(url: string, use_fallback: boolean = true): Promise<SwaggerDocument> {
  let api: SwaggerDocument;
  try {
    console.error(`[MCP] 尝试使用 SwaggerParser.dereference 解析: ${url}...`);
    api = await withTimeout(
      SwaggerParser.dereference(url) as Promise<SwaggerDocument>,
      DEFAULT_TIMEOUT_MS,
      `SwaggerParser 解析超时 (${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s)`
    );
    console.error(`[MCP] ✅ SwaggerParser 解析成功`);
  } catch (parseError: any) {
    console.error(`[MCP] ⚠️ SwaggerParser 解析失败: ${parseError.message}`);
    
    if (use_fallback) {
      try {
        console.error(`[MCP] 🔄 正在启用降级策略，尝试直接读取 JSON...`);
        api = await fetchRawSwagger(url);
        console.error(`[MCP] ✅ 降级策略成功：已读取原始 JSON`);
      } catch (fallbackError: any) {
        throw new Error(`SwaggerParser 和降级策略均失败。\nSwaggerParser: ${parseError.message}\n降级策略: ${fallbackError.message}`);
      }
    } else {
      throw parseError;
    }
  }
  return api;
}

// 4. 简化 schema 引用（保留关键 Schema 信息）
function simplifyPaths(paths: Record<string, any>): Record<string, any> {
  const simplified: Record<string, any> = {};
  
  for (const [pathKey, pathValue] of Object.entries(paths)) {
    if (!pathValue) continue;
    simplified[pathKey] = {};
    
    // 遍历 HTTP 方法 (get, post, put, etc.)
    for (const [method, operation] of Object.entries(pathValue)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation === "object" && operation !== null) {
        const op = operation as any;
        simplified[pathKey][method] = {
          summary: op.summary || "",
          description: op.description || "",
          operationId: op.operationId || "",
          tags: op.tags || [],
          parameters: op.parameters?.map((p: any) => {
            // p 可能是 ReferenceObject 或 ParameterObject。由于已 dereference，假设为 ParameterObject
            // 但为了安全，如果有 schema 属性则保留
            return {
              name: p.name,
              in: p.in,
              required: p.required,
              description: p.description,
              schema: extractParameterSchema(p),
            };
          }) || [],
          // request body: OpenAPI3 -> requestBody; Swagger2 -> parameters[in=body]
          requestBody: (() => {
            if (op.requestBody && typeof op.requestBody === "object") {
              const rb = op.requestBody as OpenAPIV3.RequestBodyObject;
              return {
                required: rb.required,
                description: rb.description,
                content: rb.content,
              };
            }
            const bodyParam = Array.isArray(op.parameters)
              ? op.parameters.find((p: any) => p && typeof p === "object" && p.in === "body")
              : undefined;
            if (bodyParam) {
              return {
                required: bodyParam.required,
                description: bodyParam.description,
                schema: extractParameterSchema(bodyParam),
              };
            }
            return undefined;
          })(),
          // responses: OpenAPI3 -> content; Swagger2 -> schema
          responses: Object.entries(op.responses || {}).reduce((acc: any, [code, resp]) => {
            const r = resp as any;
            acc[code] = {
              description: r.description || "",
              content: r.content,
              schema: r.schema,
            };
            return acc;
          }, {}),
        };
      }
    }
  }
  
  return simplified;
}

// 5. 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_controller_tags",
        description: "第一步：只返回 Swagger 文档中的 Tags (控制器/模块) 列表。使用此工具先了解有哪些模块，再决定查看具体细节。",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Swagger 文档 URL" },
            use_fallback: { type: "boolean", description: "是否在解析失败时使用降级策略", default: true },
          },
          required: ["url"],
        },
      },
      {
        name: "read_swagger_api",
        description: "第二步：读取 Swagger/OpenAPI 文档并返回接口定义。支持按 Tag 或关键词过滤，并可生成 TS 类型和 Mock 数据。",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Swagger 文档 URL" },
            path_pattern: { type: "string", description: "关键词搜索 (URL/Summary/Description)" },
            tag: { type: "string", description: "按 Tag (模块) 过滤" },
            generate_ts: { type: "boolean", description: "是否生成 TS 类型定义", default: true },
            generate_mock: { type: "boolean", description: "是否生成 Mock 数据", default: false },
            use_fallback: { type: "boolean", description: "是否在解析失败时使用降级策略", default: true },
          },
          required: ["url"],
        },
      },
      {
        name: "validate_swagger",
        description: "健康检查：检查 Swagger 文档是否可访问及解析正常，不返回具体内容。",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Swagger 文档 URL" },
          },
          required: ["url"],
        },
      },
    ],
  };
});

// 6. 处理工具调用逻辑
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const rawArgs = (args ?? {}) as unknown;

  try {
    // --- 工具 1: validate_swagger ---
    if (name === "validate_swagger") {
      const parsed = UrlOnlyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw new Error(`参数校验失败: ${formatZodError(parsed.error)}`);
      const { url, use_fallback } = parsed.data;
      console.error(`[MCP] 调用工具: ${name}, URL: ${url}`);
      const api = await getSwaggerApi(url, use_fallback);

      const version = (api as any).openapi || (api as any).swagger || "unknown";
      const title = api.info?.title || "No Title";
      const pathCount = Object.keys(api.paths || {}).length;
      return {
        content: [{ type: "text", text: `✅ Swagger 文档解析成功！\n版本: ${version}\n标题: ${title}\n接口数量: ${pathCount}` }],
        isError: false,
      };
    }

    // --- 工具 2: list_controller_tags ---
    if (name === "list_controller_tags") {
      const parsed = UrlOnlyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw new Error(`参数校验失败: ${formatZodError(parsed.error)}`);
      const { url, use_fallback } = parsed.data;
      console.error(`[MCP] 调用工具: ${name}, URL: ${url}`);
      const api = await getSwaggerApi(url, use_fallback);

      const tagsMap = new Map<string, string>();
      
      // 1. 获取顶层 Tags
      if (api.tags) {
        api.tags.forEach((t: any) => tagsMap.set(t.name, t.description || ""));
      }

      // 2. 扫描所有 Paths 收集 Tags
      for (const pathValue of Object.values(api.paths || {})) {
        for (const op of getOperations(pathValue)) {
          if (op && op.tags && Array.isArray(op.tags)) {
            op.tags.forEach((tagName: string) => {
              if (!tagsMap.has(tagName)) tagsMap.set(tagName, "");
            });
          }
        }
      }

      const sortedTags = Array.from(tagsMap.entries())
        .map(([name, desc]) => ({ name, description: desc }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      return {
        content: [{ type: "text", text: JSON.stringify(sortedTags, null, 2) }],
        isError: false,
      };
    }

    // --- 工具 3: read_swagger_api ---
    if (name === "read_swagger_api") {
      const parsed = ReadSwaggerApiArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw new Error(`参数校验失败: ${formatZodError(parsed.error)}`);
      const { url, use_fallback, path_pattern, tag, generate_ts, generate_mock } = parsed.data;
      console.error(`[MCP] 调用工具: ${name}, URL: ${url}`);
      const api = await getSwaggerApi(url, use_fallback);

      const paths = api.paths || {};
      const filteredPaths: Record<string, any> = {};
      let matchCount = 0;

      // 过滤逻辑
      for (const [pathKey, pathValue] of Object.entries(paths)) {
        if (!pathValue) continue;
        
        // 必须满足 path_pattern (匹配 URL/Summary/Description)
        let patternMatch = true;
        if (path_pattern) {
          const lowerPattern = path_pattern.toLowerCase();
          const inUrl = pathKey.toLowerCase().includes(lowerPattern);
          let inMeta = false;
          
          // 检查该 path 下的任一 method 是否匹配
          for (const op of getOperations(pathValue)) {
            if (
              op.summary?.toLowerCase().includes(lowerPattern) ||
              op.description?.toLowerCase().includes(lowerPattern)
            ) {
              inMeta = true;
              break;
            }
          }
          patternMatch = inUrl || inMeta;
        }

        if (!patternMatch) continue;

        // 必须满足 tag
        let tagMatch = true;
        if (tag) {
           tagMatch = false;
           for (const op of getOperations(pathValue)) {
            if (op && op.tags && op.tags.includes(tag)) {
              tagMatch = true;
              break;
            }
           }
        }

        if (tagMatch) {
          filteredPaths[pathKey] = pathValue;
          matchCount++;
        }
      }

      if (matchCount === 0) {
        return {
          content: [{ type: "text", text: `未找到匹配的接口。\npath_pattern: ${path_pattern || "无"}\ntag: ${tag || "无"}\n\n请尝试使用 list_controller_tags 查看可用模块，或检查关键词。` }],
          isError: false,
        };
      }

      // 简化 Paths
      const simplifiedPaths = simplifyPaths(filteredPaths);

      // 生成 Mock 数据
      if (generate_mock) {
        for (const pathItem of Object.values(simplifiedPaths)) {
          for (const method of Object.keys(pathItem)) {
             const op = pathItem[method];
             const successCode = Object.keys(op.responses || {}).find(c => c.startsWith("2")) || "200";
             const respObj = op.responses[successCode];
             if (respObj) {
                const mediaType = respObj.content ? Object.keys(respObj.content)[0] : undefined;
                const schema = mediaType ? respObj.content?.[mediaType]?.schema : respObj.schema;
                if (schema) op.mock_response = generateMockData(schema);
             }
          }
        }
      }

      const result = {
        _meta: {
          url,
          filtered_count: matchCount,
          filters: { path_pattern, tag }
        },
        baseUrl: (() => {
          const anyApi = api as any;
          if (anyApi.host) {
            const scheme =
              Array.isArray(anyApi.schemes) && anyApi.schemes.length > 0
                ? anyApi.schemes[0]
                : new URL(url).protocol.replace(":", "");
            return `${scheme}://${anyApi.host}${anyApi.basePath || ""}`;
          }
          return anyApi.servers?.[0]?.url || "";
        })(),
        paths: simplifiedPaths
      };

      // 循环引用与深度处理
      const safeResult = sanitizeRecursive(result, 0, 30);
      let finalText = JSON.stringify(safeResult, null, 2);

      // TypeScript 类型生成
      if (generate_ts) {
        try {
           const definitions = (api as any).components?.schemas || (api as any).definitions;
           if (definitions) {
              // 构造一个包含定义的临时 Schema 用于生成全部相关类型
              // 注意：为了让 json-schema-to-typescript 正确解析引用，我们可能需要保留原始结构的一部分
              // 这里简化处理，尝试直接转换 definitions
              // 由于 compile 期望完整 schema，我们构造一个 root
              const tempSchema = {
                definitions: definitions, // Swagger 2.0
                components: { schemas: definitions }, // OpenAPI 3
                type: "object",
                additionalProperties: false
              };
              
              // 使用 compile 生成
              const ts = await compile(tempSchema as any, "API_Definitions", { 
                 bannerComment: "", 
                 additionalProperties: false,
                 unreachableDefinitions: true // 确保生成所有定义，即使 root 没引用
              });
              
              finalText += `\n\n/* ----- Generated TypeScript Definitions ----- */\n${ts}`;
           }
        } catch (e: any) {
           finalText += `\n\n/* [TS Generation Error]: ${e.message} */`;
        }
      }

      return {
        content: [{ type: "text", text: finalText }],
        isError: false,
      };
    }

    throw new Error(`未知工具: ${name}`);

  } catch (error: any) {
    console.error(`[MCP] 执行错误: ${error.message}`);
    return {
      content: [
        {
          type: "text",
          text: `操作失败: ${error.message}\n请检查 URL 是否正确或服务是否可用。`,
        },
      ],
      isError: true,
    };
  }
});

// 7. 启动服务
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`MCP Swagger Reader v${VERSION} 运行中...`);
