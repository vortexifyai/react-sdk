export class VortexifyError extends Error {
  constructor(message: string, public status?: number, public response?: unknown) {
    super(message);
    this.name = "VortexifyError";
  }
}
