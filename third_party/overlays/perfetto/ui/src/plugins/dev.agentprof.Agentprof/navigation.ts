// SPDX-License-Identifier: Apache-2.0
import type {Trace} from '../../public/trace';

let exampleEngineId: string | undefined;
let exampleRouteId = '1';
export function markExample(trace: Trace, routeId = '1'): void {
  exampleEngineId = trace.engine.engineId;
  exampleRouteId = routeId;
}
export function navigate(trace: Trace, route: string): void {
  const suffix = trace.engine.engineId === exampleEngineId
    ? `?agentprof_example=${exampleRouteId}&local_cache_key=`
    : '';
  trace.navigate(`#!${route}${suffix}`);
}
