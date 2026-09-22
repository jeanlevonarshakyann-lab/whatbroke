// What the exit status itself says, when the output said nothing.
//
// A command that is killed writes nothing on the way out. `cargo build` stopped by the
// kernel's out-of-memory killer, a test run cancelled by a CI job's timeout, a native
// crash in a C extension - all of them end with an empty log and a number, and every
// parser in this repository has nothing to read. The number is not nothing: node hands
// over the signal that killed the child, and a signal is a fact about what happened,
// not a guess about what went wrong.
//
// Two kinds of thing are said here, and they are not equally certain:
//
//   - A signal is reported by the operating system. SIGKILL means SIGKILL. What usually
//     sends it is a guess, and is written as one.
//   - An exit code is a number a program chose, and 126, 127 and 124 mean something only
//     by convention - a shell's, and GNU coreutils'. They are described as conventions,
//     and only for a command whyitbroke ran itself, where the shell in question is the one
//     it spawned. A piped log's upstream status is not whyitbroke's to interpret.
//
// Nothing here is invented from an exit code alone: 1 and 2 are what every program in the
// world returns, and grep returns 1 for finding nothing.

// The signal, then what it means, then where it usually comes from. The second sentence is
// the guess, and reads like one.
const SIGNALS = {
  SIGKILL: "Killed by SIGKILL, which no program can catch or shut down cleanly for. On a build machine that is usually the kernel running out of memory, or a runner enforcing a limit.",
  SIGTERM: "Stopped by SIGTERM: something asked it to exit. A job timeout, a cancelled CI run and `docker stop` all send it.",
  SIGINT: "Interrupted by SIGINT, which is what Ctrl-C sends.",
  SIGQUIT: "Quit by SIGQUIT, which is what Ctrl-\\ sends - and what a JVM is sent to make it dump its threads.",
  SIGHUP: "Hung up by SIGHUP: the terminal or connection it was attached to went away.",
  SIGSEGV: "Crashed with SIGSEGV: it touched memory it does not own. The fault is in native code - the program itself, a C extension, or a library under it.",
  SIGBUS: "Crashed with SIGBUS: a memory access the hardware refused. A mapped file truncated underneath it does this.",
  SIGILL: "Crashed with SIGILL: an instruction this processor does not have. A binary built for another architecture does this.",
  SIGFPE: "Crashed with SIGFPE: an arithmetic fault, usually an integer divided by zero.",
  SIGABRT: "Aborted with SIGABRT: the program stopped itself. A failed assertion, an uncaught C++ exception, or a runtime giving up all raise it.",
  SIGPIPE: "Ended by SIGPIPE: it wrote to a pipe nothing was reading any more, because the command it was piped into had already exited.",
  SIGXCPU: "Stopped by SIGXCPU: it used more CPU time than the limit allowed.",
  SIGXFSZ: "Stopped by SIGXFSZ: it tried to write a file bigger than the limit allowed.",
};

// Conventions, not facts, and said as conventions. Only a shell returns these on purpose;
// a program is free to mean something else by the same number, so the sentence says what
// the number conventionally is rather than what this run did.
const CODES = {
  126: "Exit code 126 is a shell's way of saying the file is there but could not be run: not executable, or not a program.",
  127: "Exit code 127 is a shell's way of saying the command does not exist. Check the name, or whether it is installed here.",
  124: "Exit code 124 is what `timeout` returns when its deadline passed and it killed the command.",
};

/** What the exit status says on its own, or null when it says nothing worth printing.
 *
 *  `signal` is the name node reports for a child killed by one, and is the only part of
 *  this that is a fact. `inputMode` gates the exit codes: whyitbroke ran the command, or it
 *  did not, and a piped log's number belongs to whoever produced it. */
export function exitStatus({ code = null, signal = null, inputMode = "command" } = {}) {
  if (signal) return { signal, code, says: SIGNALS[signal] ?? `Stopped by ${signal}.` };
  if (inputMode !== "command") return null;
  const says = CODES[code];
  return says ? { signal: null, code, says } : null;
}
