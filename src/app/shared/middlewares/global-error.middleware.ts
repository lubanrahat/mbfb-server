import type { Request, Response, NextFunction } from "express";
import AppError from "../errors/app-error";
import { ResponseUtil } from "../utils/response.util";
import { ZodError } from "zod";
import HttpStatus from "../constants/http-status";
import ErrorCodes from "../errors/error-codes";
import { logger } from "../logger/logger";

const PG_ERROR_MAP: Record<
  string,
  { status: number; code: ErrorCodes; message: string }
> = {
  // Class 23 — Integrity Constraint Violations
  "23505": {
    status: HttpStatus.CONFLICT,
    code: ErrorCodes.DUPLICATE_ENTRY,
    message: "A record with that value already exists",
  },
  "23503": {
    status: HttpStatus.BAD_REQUEST,
    code: ErrorCodes.FOREIGN_KEY_CONSTRAINT,
    message: "Referenced record does not exist",
  },
  "23502": {
    status: HttpStatus.BAD_REQUEST,
    code: ErrorCodes.NOT_NULL_VIOLATION,
    message: "A required field is missing",
  },
  "23514": {
    status: HttpStatus.BAD_REQUEST,
    code: ErrorCodes.CHECK_VIOLATION,
    message: "Value violates a check constraint",
  },
  // Class 22 — Data Exception
  "22P02": {
    status: HttpStatus.BAD_REQUEST,
    code: ErrorCodes.DATA_TYPE_ERROR,
    message: "Invalid input data type",
  },
  // Class 08 — Connection Exceptions
  "08000": {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ErrorCodes.DATABASE_CONNECTION_ERROR,
    message: "Database connection error",
  },
  "08003": {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ErrorCodes.DATABASE_CONNECTION_ERROR,
    message: "Database connection lost",
  },
  "08006": {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ErrorCodes.DATABASE_CONNECTION_ERROR,
    message: "Database connection failure",
  },
};

function isNeonDbError(
  err: unknown,
): err is Error & { code: string; detail?: string; constraint?: string } {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as any).code === "string" &&
    /^\d{5}$/.test((err as any).code)
  );
}

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  // ─── AppError (custom operational errors) ───
  if (err instanceof AppError) {
    return ResponseUtil.error(
      res,
      err.message,
      err.statusCode,
      err.code,
      err.details,
    );
  }

  // ─── Zod validation errors ───
  if (err instanceof ZodError) {
    const formattedErrors = err.issues.map((issue) => ({
      field: issue.path.length ? issue.path.join(".") : "_root",
      message: issue.message,
    }));

    return ResponseUtil.error(
      res,
      "Validation failed",
      HttpStatus.BAD_REQUEST,
      ErrorCodes.VALIDATION_ERROR,
      formattedErrors,
    );
  }

  // ─── PostgreSQL / Neon database errors ───
  if (isNeonDbError(err)) {
    const mapped = PG_ERROR_MAP[err.code];

    if (mapped) {
      logger.warn("Database error:", {
        code: err.code,
        detail: err.detail,
        constraint: err.constraint,
      });

      return ResponseUtil.error(
        res,
        mapped.message,
        mapped.status,
        mapped.code,
        process.env.NODE_ENV !== "production"
          ? { pgCode: err.code, detail: err.detail, constraint: err.constraint }
          : undefined,
      );
    }

    // Unmapped PG error — treat as a generic database error
    logger.error("Unhandled database error:", {
      code: err.code,
      message: err.message,
      detail: err.detail,
    });

    return ResponseUtil.error(
      res,
      "A database error occurred",
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCodes.DATABASE_ERROR,
    );
  }

  // ─── Malformed JSON body (Express / body-parser SyntaxError) ───
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as any).status === 400 &&
    "body" in err
  ) {
    return ResponseUtil.error(
      res,
      "Malformed JSON in request body",
      HttpStatus.BAD_REQUEST,
      ErrorCodes.INVALID_JSON,
    );
  }

  // ─── Multer / file upload errors ───
  if (err instanceof Error && err.message === "Unexpected field") {
    return ResponseUtil.error(
      res,
      "Invalid file field name. Please check the expected field name in the API documentation.",
      HttpStatus.BAD_REQUEST,
      ErrorCodes.INVALID_FILE_FIELD,
    );
  }

  if (err instanceof Error && err.message.includes("File too large")) {
    return ResponseUtil.error(
      res,
      "File size exceeds the allowed limit",
      HttpStatus.BAD_REQUEST,
      ErrorCodes.FILE_TOO_LARGE,
    );
  }

  // ─── JWT errors ───
  if (err instanceof Error && err.name === "JsonWebTokenError") {
    return ResponseUtil.error(
      res,
      "Invalid token",
      HttpStatus.UNAUTHORIZED,
      ErrorCodes.INVALID_TOKEN,
    );
  }

  if (err instanceof Error && err.name === "TokenExpiredError") {
    return ResponseUtil.error(
      res,
      "Token expired",
      HttpStatus.UNAUTHORIZED,
      ErrorCodes.TOKEN_EXPIRED,
    );
  }

  if (err instanceof Error && err.name === "NotBeforeError") {
    return ResponseUtil.error(
      res,
      "Token not yet active",
      HttpStatus.UNAUTHORIZED,
      ErrorCodes.INVALID_TOKEN,
    );
  }

  // ─── TypeError / URIError (bad client input hitting runtime) ───
  if (err instanceof URIError) {
    return ResponseUtil.error(
      res,
      "Malformed URI",
      HttpStatus.BAD_REQUEST,
      ErrorCodes.BAD_REQUEST,
    );
  }

  // ─── Log unexpected errors ───
  logger.error("Unhandled error:", err);

  // ─── Default fallback ───
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? (err as any).message
          : "Unknown error";

  return ResponseUtil.error(
    res,
    message,
    HttpStatus.INTERNAL_SERVER_ERROR,
    ErrorCodes.INTERNAL_ERROR,
  );
};
