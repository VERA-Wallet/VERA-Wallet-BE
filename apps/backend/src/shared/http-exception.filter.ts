import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { redactSecrets } from "./redact";

@Catch()
export class HttpExceptionEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const object = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    // 우리가 **의도적으로** 만든 HttpException의 문구만 밖으로 내보낸다.
    // 잡히지 않은 예외의 원문은 외부 라이브러리가 쓴 것이라 자격증명·내부 경로가 섞여 있을 수 있다
    // (실제로 viem은 RPC URL을 메시지에 넣고, 그 URL의 쿼리에 API 토큰이 있다).
    const declared = Array.isArray(object.message)
      ? object.message.join(", ")
      : typeof object.message === "string" ? object.message : null;
    const message = declared ?? "Internal server error.";
    const code = typeof object.code === "string"
      ? object.code
      : status === 401 ? "unauthorized"
        : status === 404 ? "not_found"
          : status === 409 ? "conflict"
            : status >= 500 ? "internal_error" : "invalid_request";
    if (status === 409 && code === "version_conflict" && typeof object.details === "object" && object.details !== null && "data" in object.details) {
      response.status(status).json({ error: { code, message: redactSecrets(message) }, data: (object.details as { data: unknown }).data });
      return;
    }
    response.status(status).json({ error: { code, message: redactSecrets(message), ...(object.details === undefined ? {} : { details: object.details }) } });
  }
}
