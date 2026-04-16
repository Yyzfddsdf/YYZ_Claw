export function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`
  });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (String(error?.name ?? "") === "MulterError") {
    const code = String(error?.code ?? "").trim();
    const messageByCode = {
      LIMIT_FILE_SIZE: "上传文件过大，单文件大小不能超过 20MB",
      LIMIT_FILE_COUNT: "上传文件数量超出限制",
      LIMIT_FIELD_VALUE: "请求字段过长，请减少单次消息体积或拆分发送",
      LIMIT_UNEXPECTED_FILE: "上传字段不正确，请使用 files 字段上传"
    };

    res.status(400).json({
      error: messageByCode[code] || error?.message || "文件上传失败"
    });
    return;
  }

  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const message = error?.message || "Internal server error";

  res.status(statusCode).json({ error: message });
}
