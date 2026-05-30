#!/usr/bin/env node

/**
 * MCP Server for Huawei Cloud OBS (S3-compatible object storage)
 *
 * Provides tools:
 *   - s3_upload:       Upload a local file to OBS, return the object URL
 *   - s3_download:     Download an object from OBS to a local path
 *   - s3_list:         List objects in the bucket
 *   - s3_generate_url: Generate a signed download URL
 *
 * Transport modes (via MCP_TRANSPORT env var):
 *   - "stdio" (default): JSON-RPC over stdin/stdout, launched as subprocess
 *   - "http":            Streamable HTTP server (MCP 2025-03-26 spec), for remote/Docker use
 *
 * Configuration via environment variables:
 *   OBS_ACCESS_KEY_ID     (required)
 *   OBS_SECRET_ACCESS_KEY (required)
 *   OBS_ENDPOINT          (required, e.g. https://obs.cn-north-4.myhuaweicloud.com)
 *   OBS_BUCKET            (required)
 *   OBS_UPLOAD_PREFIX     (optional, key prefix for uploads, default "uploads/")
 *   OBS_URL_EXPIRES       (optional, signed URL expiry in seconds, default 3600)
 *   MCP_TRANSPORT         (optional, "stdio" or "http", default "stdio")
 *   MCP_PORT              (optional, HTTP listen port, default 3100)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { ObsClient, ObsResult, ObsObject } from "./obs-types.js";

const require = createRequire(import.meta.url);
const ObsClientCtor = require("esdk-obs-nodejs") as ObsClient;

// ─── OBS Client (lazy init) ──────────────────────────────────────────────────

type ObsClientInstance = InstanceType<ObsClient>;

let _obs: ObsClientInstance | null = null;

function getObsClient(): ObsClientInstance {
  if (_obs) return _obs;

  const ak = process.env.OBS_ACCESS_KEY_ID;
  const sk = process.env.OBS_SECRET_ACCESS_KEY;
  const endpoint = process.env.OBS_ENDPOINT;

  if (!ak || !sk || !endpoint) {
    throw new Error(
      "Missing OBS config. Set: OBS_ACCESS_KEY_ID, OBS_SECRET_ACCESS_KEY, OBS_ENDPOINT, OBS_BUCKET"
    );
  }

  _obs = new ObsClientCtor({
    access_key_id: ak,
    secret_access_key: sk,
    server: endpoint,
  });

  return _obs;
}

function getBucket(): string {
  const b = process.env.OBS_BUCKET;
  if (!b) throw new Error("OBS_BUCKET environment variable is not set");
  return b;
}

function getUploadPrefix(): string {
  return process.env.OBS_UPLOAD_PREFIX || "uploads/";
}

function getUrlExpires(): number {
  return parseInt(process.env.OBS_URL_EXPIRES || "3600", 10);
}

// ─── Tool Registration ───────────────────────────────────────────────────────

function registerTools(server: McpServer): void {
  // Tool: s3_upload
  server.tool(
    "s3_upload",
    "Upload a local file to Huawei Cloud OBS. Returns the object key and a signed download URL.",
    {
      file_path: z.string().describe("Absolute path to the local file to upload"),
      key: z.string().optional().describe(
        "Object key in OBS (auto-generated from filename + date prefix if omitted)"
      ),
      content_type: z.string().optional().describe(
        "MIME type (auto-detected from extension if omitted)"
      ),
    },
    async ({ file_path, key, content_type }) => {
      const obs = getObsClient();
      const bucket = getBucket();

      const resolved = path.resolve(file_path);
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: "text" as const, text: `Error: file not found: ${resolved}` }], isError: true };
      }

      const filename = path.basename(resolved);
      const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
      const objectKey = key || `${getUploadPrefix()}${datePrefix}/${crypto.randomUUID()}_${filename}`;
      const ct = content_type || detectContentType(filename);

      const result = await new Promise<ObsResult>((resolve, reject) => {
        obs.uploadFile({
          Bucket: bucket,
          Key: objectKey,
          UploadFile: resolved,
          ContentType: ct,
        }, (err, res) => {
          if (err) reject(new Error(String(err)));
          else resolve(res);
        });
      });

      if (result.CommonMsg.Status >= 300) {
        return {
          content: [{ type: "text" as const, text: `Upload failed: ${result.CommonMsg.Code} - ${result.CommonMsg.Message}` }],
          isError: true,
        };
      }

      const signedUrl = generateSignedUrl(obs, bucket, objectKey, getUrlExpires());

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            key: objectKey,
            filename: filename,
            content_type: ct,
            size_bytes: fs.statSync(resolved).size,
            url: signedUrl,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: s3_download
  server.tool(
    "s3_download",
    "Download an object from Huawei Cloud OBS to a local path.",
    {
      key: z.string().describe("Object key in OBS (the 'key' returned by s3_upload)"),
      output_path: z.string().describe("Local directory or full file path to save the downloaded file"),
    },
    async ({ key, output_path }) => {
      const obs = getObsClient();
      const bucket = getBucket();

      const resolved = path.resolve(output_path);
      let savePath: string;

      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        savePath = path.join(resolved, path.basename(key));
      } else {
        savePath = resolved;
        const dir = path.dirname(savePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      const result = await new Promise<ObsResult>((resolve, reject) => {
        obs.downloadFile({
          Bucket: bucket,
          Key: key,
          DownloadFile: savePath,
        }, (err, res) => {
          if (err) reject(new Error(String(err)));
          else resolve(res);
        });
      });

      if (result.CommonMsg.Status >= 300) {
        return {
          content: [{ type: "text" as const, text: `Download failed: ${result.CommonMsg.Code} - ${result.CommonMsg.Message}` }],
          isError: true,
        };
      }

      const stat = fs.statSync(savePath);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            key: key,
            file_path: savePath,
            size_bytes: stat.size,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: s3_list
  server.tool(
    "s3_list",
    "List objects in the OBS bucket with an optional prefix filter.",
    {
      prefix: z.string().optional().describe("Only list objects with this key prefix"),
      max_keys: z.number().optional().describe("Max number of objects to return (default 100)"),
    },
    async ({ prefix, max_keys }) => {
      const obs = getObsClient();
      const bucket = getBucket();

      const result = await obs.listObjects({
        Bucket: bucket,
        Prefix: prefix || "",
        MaxKeys: max_keys || 100,
      });

      if (result.CommonMsg.Status >= 300) {
        return {
          content: [{ type: "text" as const, text: `List failed: ${result.CommonMsg.Code} - ${result.CommonMsg.Message}` }],
          isError: true,
        };
      }

      const objects = (result.InterfaceResult.Contents || []).map((obj: ObsObject) => ({
        key: obj.Key,
        size: parseInt(obj.Size, 10),
        last_modified: obj.LastModified,
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: objects.length, objects }, null, 2),
        }],
      };
    }
  );

  // Tool: s3_generate_url
  server.tool(
    "s3_generate_url",
    "Generate a signed download URL for an existing object in OBS.",
    {
      key: z.string().describe("Object key in OBS"),
      expires: z.number().optional().describe("URL expiry in seconds (default from OBS_URL_EXPIRES env)"),
    },
    async ({ key, expires }) => {
      const obs = getObsClient();
      const bucket = getBucket();
      const ttl = expires || getUrlExpires();
      const url = generateSignedUrl(obs, bucket, key, ttl);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ key, url, expires_seconds: ttl }, null, 2),
        }],
      };
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONTENT_TYPE_MAP: Record<string, string> = {
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  gz: "application/gzip",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

function detectContentType(filename: string): string {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return CONTENT_TYPE_MAP[ext] || "application/octet-stream";
}

function generateSignedUrl(
  obs: ObsClientInstance,
  bucket: string,
  key: string,
  expires: number,
): string {
  try {
    const res = obs.createSignedUrlSync({
      Method: "GET",
      Bucket: bucket,
      Key: key,
      Expires: expires,
    });
    return res.SignedUrl;
  } catch {
    const endpoint = (process.env.OBS_ENDPOINT || "").replace(/^https?:\/\//, "");
    return `https://${bucket}.${endpoint}/${key}`;
  }
}

// ─── Transport: HTTP (Streamable HTTP) ───────────────────────────────────────

async function startHttpServer(port: number): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(), // stateful mode: required for multi-request sessions
  });

  const mcpServer = new McpServer({
    name: "obs-s3",
    version: "1.1.0",
  });
  registerTools(mcpServer);
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      // Parse body for POST requests; GET/DELETE have no body
      let parsed: unknown;
      if (req.method === "POST") {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
      }
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      console.error("[mcp-obs-s3] HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`[mcp-obs-s3] HTTP server listening on port ${port}`);
  });
}

// ─── Transport: Stdio ────────────────────────────────────────────────────────

async function startStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();

  const mcpServer = new McpServer({
    name: "obs-s3",
    version: "1.1.0",
  });
  registerTools(mcpServer);
  await mcpServer.connect(transport);
  console.error("[mcp-obs-s3] Server started on stdio");
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transportMode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

  if (transportMode === "http") {
    const port = parseInt(process.env.MCP_PORT || "3100", 10);
    await startHttpServer(port);
  } else {
    await startStdioServer();
  }
}

main().catch((err: unknown) => {
  console.error("[mcp-obs-s3] Fatal:", err);
  process.exit(1);
});
