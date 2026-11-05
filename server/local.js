import crypto from 'node:crypto';

/** Where this server is listening, and the token the local MCP bridge uses to call tools. */
export const local = {
  url: null,
  token: crypto.randomBytes(24).toString('hex'),
};
