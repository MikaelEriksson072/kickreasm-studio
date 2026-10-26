/* VICE binary monitor client (spec 13.3) is milestone M3. The IPC channels exist so the contract
 * in spec 13.4 is complete; until then they answer with a clear "not available" result. */
import type { ViceAttachRequest, ViceCommandRequest, ViceResult } from '../../shared/ipc';

const NOT_YET: ViceResult = { ok: false, error: 'The VICE binary monitor (breakpoints, live memory, hot reload) arrives in milestone M3. Use Build & Run to start VICE with labels.' };

export async function viceAttach(_req: ViceAttachRequest): Promise<ViceResult> {
  return NOT_YET;
}

export async function viceCommand(_req: ViceCommandRequest): Promise<ViceResult> {
  return NOT_YET;
}
