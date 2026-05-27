# Anti-Mission Tests

Normal tests prove the system works.

Anti-mission tests prove AMCA does not betray its purpose.

Examples:

- unsupported final claims are blocked;
- missing evidence references are blocked;
- cross-run evidence is blocked;
- stale current-state observations are blocked;
- raw provider final text is blocked for governed release;
- adapter receipt candidates cannot support proof before AMCA admission;
- provider metadata and tool-call IDs cannot become evidence;
- LangGraph and Temporal state cannot become proof;
- telemetry, audit, eval, benchmark, and replay output cannot become proof;
- direct mutation, approval, receipt, and release authority smuggling is
  blocked.
