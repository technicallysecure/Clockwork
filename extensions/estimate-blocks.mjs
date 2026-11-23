export default {
  hostedSafe: true,
  name: 'estimate_blocks',
  description: 'Divide available minutes into whole focus blocks and remaining minutes.',
  permissions: ['time.estimate'],
  effect: 'read',
  network: false,
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      blockMinutes: { type: 'integer', minimum: 1, maximum: 240 }
    },
    required: ['minutes', 'blockMinutes'],
    additionalProperties: false
  },
  execute({minutes, blockMinutes}) {
    return {blocks: Math.floor(minutes / blockMinutes), remainingMinutes: minutes % blockMinutes};
  }
};
