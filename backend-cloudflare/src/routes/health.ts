import { Hono } from "hono";
import type { Env } from "../config";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/healthz", (c) => c.json({ status: "ok", environment: c.env.ENVIRONMENT }));
