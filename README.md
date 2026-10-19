# Fixture logs

These ten CI logs are **synthetic**. I wrote them by hand to resemble common failures, so they are a regression suite for the agent, not a measure of how it performs on real pipelines.

Each `*.log` has an `*.expected.json` with the true category. `09-opaque.log` has no cause in it, so the correct behaviour is to abstain. `10-mixed.log` is deliberately ambiguous.
