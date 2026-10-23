# Stack discipline

Injected into every role whose definition sets `stack_aware: true`. Written
once here because repeating it in sixty role files would cost tokens on every
invocation and drift between copies.

## Why this exists

An agent writing code in a framework it knows well fails in one specific way:
it recalls an API that was correct in a version the project does not use. The
output looks idiomatic, reviews cleanly, and does not work — or worse, works
differently. This is the single largest source of confidently wrong code, and
it is not fixed by knowing the framework better. It is fixed by not recalling.

## The rule

**Never write an API call from memory. Read it from what is installed.**

Recall is for deciding *what* to reach for. The exact name, signature, option
shape and return type come from the dependency that is actually in this
project, at the version actually in the lockfile.

## Procedure

### 1. Pin the stack before writing anything

Read, in this order:

1. The manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
   `Gemfile`, `pom.xml`).
2. The **lockfile**, which is the only honest statement of what is installed.
   The manifest says `^5.2`; the lockfile says `5.4.1`, and the difference is
   where the hallucination lives.
3. The language and runtime version, including the floor the project supports.
4. The build and test configuration, which reveals module system, path
   aliases, strictness and target.

Record what was found. A later step that contradicts the pinned version is a
defect, not a judgement call.

### 2. Verify before use

Before using any API that is not trivially certain, confirm it against the
installed package:

- Read its type declarations or signatures from the installed tree.
- Read its own documentation if it ships any.
- Find an existing call site in **this** repository. An existing working call
  is the strongest available evidence, because it has already survived this
  project's version and configuration.

"Not trivially certain" includes: anything added or changed in a recent major
version, anything with an options object, anything async, anything with
overloads, and anything whose name is close to a differently-behaving sibling.

### 3. Follow the repository over the ecosystem

Where this project's existing pattern differs from the ecosystem default, the
project wins. Consistency inside one codebase is worth more than matching a
blog post, and a lone file written in a different idiom costs every future
reader a double-take.

If the project pattern is genuinely wrong, say so and escalate. Do not
silently introduce a second convention: that leaves the codebase with two,
which is worse than one bad one.

### 4. Never invent a dependency

Do not add a package to solve a problem the installed set already solves.
Adding a dependency is an escalation, every time. Check what is already
present first — most projects already have the thing.

An import of a package that is not in the lockfile is a hallucination with a
plausible name, and it fails at the worst moment: install time on someone
else's machine.

### 5. Say when you are unsure

If an API cannot be verified from the installed tree, state that plainly and
either verify it by running it or escalate. A guess marked as a guess is
useful. A guess presented as knowledge is the failure this whole section
exists to prevent.

## Version-sensitive areas, by frequency

Where recalled knowledge goes wrong most often. Check the installed version
specifically on:

- **Major-version renames and removals.** The method moved, the default
  flipped, the option was replaced by three narrower ones.
- **Framework rendering and data-loading models**, which change shape between
  majors more than almost anything else.
- **Build, module and bundler configuration**, which is version- and
  tool-specific and where defaults change quietly.
- **ORM and query-builder APIs**, especially transaction and relation syntax.
- **Date, time and money handling.** Both the library API and the correct
  behaviour. Never float for currency, never a naive local timestamp for an
  instant.
- **Authentication and crypto primitives.** Here a recalled-but-outdated API
  is not a bug, it is a vulnerability. Verify, always.
- **Test-runner assertion and mocking APIs**, which differ sharply between
  runners that look alike.

## Reporting

When the task is reported, state the versions the work was verified against.
That turns the next person's question from "does this still work?" into a
comparison they can make in one line.
