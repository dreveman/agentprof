# Investigating an agent run

This guide describes the intended investigation workflow. Agentprof-specific
views are still planned; which questions can be answered will depend on the
events present in the Pi trace.

## Find where the time went

Start with the run's wall-clock interval. Locate the longest model requests
and tool calls, then inspect the surrounding turn. A slow tool, repeated model
requests, and a long interval without recorded work suggest different next
steps. An empty interval alone does not identify what the agent was waiting on.

## Follow delegated work

Use recorded parent/child relationships to follow subagents. Compare their
start and finish times with the parent and inspect where work overlaps. Check
whether the parent could continue or was waiting for a result, when wait events
are available.

Overlapping durations must not simply be added to estimate elapsed time.
Parallel activity can occupy more total agent time than the run's wall time.

## Inspect repeated work and usage

Look for repeated tool calls or model requests within a turn. Use recorded
arguments and outcomes to distinguish retries from distinct operations.
Where usage counters exist, inspect them alongside timing and keep missing
values distinct from zero.

## Check whether a change helped

Record comparable runs with the same task, harness settings, and model.
Consider run duration, individual operation durations, failures, and recorded
usage together. Model variability, caches, and external services can affect
results, so a single faster run is not enough to establish an improvement.
