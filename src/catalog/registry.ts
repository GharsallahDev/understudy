import type { Capability, ParamSpec } from '../types/capability.js';

/**
 * The agent-facing view of a capability: a tool an AI agent can discover and
 * invoke by name with typed args. This turns the artifact into a callable
 * contract (inputs as JSON Schema, outputs as a typed shape) without the
 * caller ever needing to read the steps.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  tenantId: string;
  vendorProduct?: string;
  approval: Capability['approval'];
  /** JSON Schema for the invocation arguments. */
  inputSchema: JsonSchema;
  /** Declared output shape. */
  outputs: Array<{ name: string; type: string; description: string }>;
  /** Number of risky/irreversible steps (a caller may want to know). */
  riskySteps: number;
}

interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string; pattern?: string; enum?: string[] }>;
  required: string[];
  additionalProperties: false;
}

function jsonType(t: ParamSpec['type']): string {
  return t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string';
}

export function inputSchema(cap: Capability): JsonSchema {
  const properties: JsonSchema['properties'] = {};
  const required: string[] = [];
  for (const p of cap.inputs) {
    properties[p.name] = {
      type: jsonType(p.type),
      description: p.description + (p.sensitive ? ' (sensitive — never logged/persisted)' : ''),
      ...(p.pattern ? { pattern: p.pattern } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export function toCatalogEntry(cap: Capability): CatalogEntry {
  return {
    id: cap.id,
    name: cap.name,
    description: cap.description,
    version: cap.version,
    tenantId: cap.target.tenantId,
    vendorProduct: cap.target.vendorProduct,
    approval: cap.approval,
    inputSchema: inputSchema(cap),
    outputs: cap.outputs.map((o) => ({ name: o.name, type: o.type, description: o.description })),
    riskySteps: cap.steps.filter((s) => s.risk === 'risky').length,
  };
}
