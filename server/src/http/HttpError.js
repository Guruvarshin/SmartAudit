/**
 * An error that knows its HTTP status. Services throw these; the App's error
 * middleware maps them to responses. Anything that is NOT an HttpError is a
 * programming fault and surfaces as an opaque 500.
 */
export class HttpError extends Error {
  constructor(status, message, { details = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }

  static badRequest(message, details) {
    return new HttpError(400, message, { details });
  }

  static notFound(message) {
    return new HttpError(404, message);
  }

  static conflict(message) {
    return new HttpError(409, message);
  }
}
