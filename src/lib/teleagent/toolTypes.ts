export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type TeleAgentToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: unknown) => Promise<unknown>;
};
