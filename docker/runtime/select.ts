import { HermesRuntime } from '../hermes/runtime.ts';
import { PiRuntime } from '../pi/runtime.ts';
import type { AgentRuntime } from './types.ts';

export type AgentRuntimeName = 'hermes' | 'pi';

function readRuntimeName(): AgentRuntimeName {
  const value = (process.env.LINGXI_AGENT_RUNTIME ?? 'hermes').trim();
  if (value === 'hermes' || value === 'pi') return value;
  throw new Error(`invalid LINGXI_AGENT_RUNTIME: ${value || '(empty)'}`);
}

export function createRuntime(): AgentRuntime {
  switch (readRuntimeName()) {
    case 'hermes':
      return new HermesRuntime();
    case 'pi':
      return new PiRuntime();
  }
}
