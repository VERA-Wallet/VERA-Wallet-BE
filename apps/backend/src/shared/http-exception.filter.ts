import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class HttpExceptionEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const object = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    const message = Array.isArray(object.message)
      ? object.message.join(", ")
      : typeof object.message === "string"
        ? object.message
        : exception instanceof Error ? exception.message : "Internal server error.";
    const code = typeof object.code === "string"
      ? object.code
      : status === 401 ? "unauthorized"
        : status === 404 ? "not_found"
          : status === 409 ? "conflict"
            : status >= 500 ? "internal_error" : "invalid_request";
    if (status === 409 && code === "version_conflict" && typeof object.details === "object" && object.details !== null && "data" in object.details) {
      response.status(status).json({ error: { code, message }, data: (object.details as { data: unknown }).data });
      return;
    }
    response.status(status).json({ error: { code, message, ...(object.details === undefined ? {} : { details: object.details }) } });
  }
}
