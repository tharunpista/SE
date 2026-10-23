# Memory data policy

The memory implementation and schemas live in `src/memory/` and `schemas/`;
those are source code and may be committed after review.

Directories beneath this folder hold runtime memory records for a user or
project. They may contain private context, decisions, or derived indexes, so
they are ignored by Git by default. Do not force-add them. If knowledge should
be shared with all repository users, curate and sanitize it into reviewed
documentation or role definitions instead of publishing a raw memory store.
