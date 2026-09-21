# Reading source files: a policy question, for review

The disclosure warning is now in the README. The behavioral options below are still here
to be decided on separately; no source-reading behavior changed.

## What happens today

When a tool reports `file:line`, whatbroke opens that file and quotes a few lines around
it. That is the feature: the point of `tsc:312` is the code at line 312.

It also means whatbroke prints lines the tool itself never printed. With a `.env` in the
working directory containing

```
API_KEY=sk-live-7f3a9c2b1d4e
DB_PASSWORD=hunter2
PORT=not-a-number
```

a validator that says `.env:3:1: error: PORT must be an integer` produces:

```
  .env:3
    error: PORT must be an integer

      1 │ API_KEY=sk-live-7f3a9c2b1d4e
      2 │ DB_PASSWORD=hunter2
      3 │ PORT=not-a-number
        │ ^
```

The tool disclosed one line number. whatbroke disclosed two secrets.

Where that lands matters more than that it happens. A terminal is ephemeral and already
had the tool's output in it. `--format github` writes the same block into
`GITHUB_STEP_SUMMARY`, which is stored with the run and readable by everyone who can read
the run — including, on a public repository, everyone.

The rest of the report does not have this property. `evidence`, `fallback.rawOutput` and
every message are quotations from the output the tool produced. Source context is the one
place whatbroke adds information the tool did not give it.

## Two fixes to refuse

**A list of sensitive filenames.** `.env` is the example, so it is the one a denylist
catches. It would not catch `.env.local`, `.env.production.local`, `secrets.yml`,
`terraform.tfvars`, `id_rsa`, `credentials.json`, `*.pem`, or the name this particular
team uses. A list that catches the example and misses the general case is worse than no
list: it reads as a guarantee and is not one, and every secret it misses is now one
somebody believed was handled.

**Turning source context off quietly.** It is why the tool is worth running. Removing it
to make a risk disappear from the changelog would be solving the wrong problem.

## The principle worth arguing from

*Whatbroke should be reluctant to disclose, in durable output, anything the tool did not
already disclose.* That is a rule about the class of information, not about filenames, so
it does not need to know what a secret looks like.

## Options

1. **Document it, change nothing.** Say in the README that source context reads files from
   disk, that `--format github` puts them in the job summary, and that `--no-source` turns
   it off. Cheap, honest, and leaves the default as the risky one.

2. **Change only the persisted default.** `--format github` quotes no source unless asked.
   The terminal keeps today's behaviour. This is the smallest change that addresses the
   part that actually persists, and `--format github` is the mode a CI config sets once and
   nobody revisits.

3. **Quote only what the tool echoed.** Show a source line from disk only where that line
   already appears in the captured output — which is true for most linters and many
   compilers, because they echo the offending line themselves. Where it is not, show the
   tool's own words and no source. Strongest guarantee, and it costs real context for
   tools that print a location and nothing else.

4. **`--source=all|echoed|none`**, defaulting to `all` in the terminal and `echoed` for
   `--format github`. Options 2 and 3 as a setting, with the default chosen per output.

## Recommendation

**Option 4, with option 1 done immediately regardless.**

The documentation costs nothing and should not wait for a decision about defaults. Beyond
that, the split default is the honest one: the risk is not "reading a file", it is "writing
what was read somewhere it will be kept", and the two outputs genuinely differ in that.
Making it a flag rather than a hidden rule means a team that wants full context in its job
summaries can say so, and a team that wants none anywhere can say that too — neither has to
discover the behaviour from an incident.

What I would not do in any of these is guess at which files are secret.
