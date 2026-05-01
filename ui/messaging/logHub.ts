import express from "express";

const LOG_BUFFER_SIZE = 500;

export class LogHub {
  private readonly buffer: string[] = [];
  private readonly clients = new Set<express.Response>();

  log(direction: "->" | "<-" | "-", channel: string, text: string, client?: string): void {
    const ts = new Date().toISOString();
    const clientPart = client ? ` [${client}]` : "";
    const entry = `[${ts}]${clientPart} ${direction} [${channel}] ${text}`;
    this.buffer.push(entry);
    if (this.buffer.length > LOG_BUFFER_SIZE) {
      this.buffer.shift();
    }
    for (const res of this.clients) {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        this.clients.delete(res);
      }
    }
    try {
      process.stdout.write(`${entry}\n`);
    } catch {
      // ignore console failure
    }
  }

  attach(res: express.Response): void {
    for (const line of this.buffer) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }
    this.clients.add(res);
  }

  detach(res: express.Response): void {
    this.clients.delete(res);
  }
}
