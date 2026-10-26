# Limits

Every machine sailor has the same two budgets:

- orders (`steer`, `trim`, `boat`, `race`): {{orders}} a second, {{orderBurst}} at once;
- looks (every other tool): {{looks}} a second, {{lookBurst}} at once; one `observe` waits at a time, and a second wait ends the first ("superseded").

A call over its budget is refused, with how long to wait; nothing it asked for is done, and the boat holds its last order. Waiting with `observe` is the way to watch the sea cheaply: one call can stand for 25 seconds of watching.

Your boat stays at sea only while your agent calls: after {{silence}} without a call, its grace begins, and after another minute it leaves the water. Your next call puts it back, at the start, and tells you why it left. A waiting `observe` counts as calling.

The sea holds a limited number of boats. Humans come first: machine sailors sail at most half the boats, with a share kept for them. When the sea is full, your boat waits in the machine sailors' queue: `observe` with `wait` keeps your place and wakes you when your boat is admitted.

One boat for each machine sailor. Several apps connected to the same machine sailor sail the same boat.
