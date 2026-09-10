// kubectl says the same thing several ways. A `get` against an unreachable cluster
// prints five identical klog lines from inside client-go and then, last, the sentence a
// person would want:
//
//   E0910 10:16:54.854783 70497 memcache.go:381] "Couldn't get current server API..." err="..."
//   ...four more identical lines...
//   The connection to the server localhost:8080 was refused - did you specify the right host or port?
//
// Nothing recognised the klog shape, so that run produced no diagnosis at all - and had
// it been recognised naively it would have produced five.
const KLOG_RE = /^[EWF]\d{4}[^\S\n]+[\d:.]+[^\S\n]+\d+[^\S\n]+(\S+?):(\d+)\][^\S\n]*(.*)$/;
const ERROR_RE = /^(?:error|Error):[^\S\n]+(.+)$/;
// `error: <anything>` is not kubectl's alone - deno writes "error: Test failed" - so in
// a log holding more than one tool the line has to say something kubectl would say.
const KUBE_ISH = /\b(?:yaml|manifest|kubectl|kubeconfig|namespace|cluster|server|resource|apiVersion|openapi|validating|parsing|context|deployment|pod|service)\b/i;
// The last line of a failed kubectl run is usually the plain-English version.
// Deliberately not "error: ..." - that is ERROR_RE's job, and it is gated on the line
// saying something kubectl would say. Repeating it here ungated let deno's
// "error: Test failed" through the side door.
const PLAIN_RE = /^(The connection to the server .+|Unable to connect to the server: .+)$/;
// kubectl appends how to work around the failure; that is not what went wrong.
const ADVICE_RE = /;[^\S\n]*if you choose to ignore these errors.*$|[^\S\n]*-[^\S\n]did you specify the right host or port\?$/;
// "error parsing deploy.yaml: ... yaml: line 9: ..." carries a real location inside it.
const IN_MESSAGE_LOC = /error parsing ([^\s:]+):.*?\byaml:[^\S\n]+line[^\S\n]+(\d+):/;

const clean = (t) => t.replace(ADVICE_RE, "").trim();

export default {
  name: "kubectl",
  category: "deploy",
  commands: ["kubectl", "oc", "helm"],

  detect: (s) =>
    /^The connection to the server .+ was refused/m.test(s) ||
    /^Unable to connect to the server:/m.test(s) ||
    (ERROR_RE.test(s.split("\n").find((l) => ERROR_RE.test(l)) ?? "") &&
      // A manifest that will not parse mentions none of kubectl's own vocabulary; what
      // gives it away is that it is YAML being turned into JSON, which is what kubectl
      // does to a manifest before sending it.
      /\b(?:kubectl|kubeconfig|openapi|apiVersion|namespaces?|kubernetes)\b|error converting YAML to JSON/.test(s)) ||
    KLOG_RE.test(s.split("\n").find((l) => KLOG_RE.test(l)) ?? ""),

  extract(s) {
    const failures = [];
    const said = new Set();
    const push = (f) => {
      // The klog lines repeat verbatim, once per retry.
      const key = f.message;
      if (!key || said.has(key)) return;
      said.add(key);
      failures.push({ severity: "error", ...f });
    };

    for (const line of s.split("\n")) {
      const err = line.match(ERROR_RE);
      if (err && KUBE_ISH.test(err[1])) {
        const at = line.match(IN_MESSAGE_LOC);
        push({
          file: at?.[1], line: at ? +at[2] : undefined,
          title: "error", label: "error", message: clean(err[1]),
        });
        continue;
      }
      const plain = line.match(PLAIN_RE);
      if (plain) { push({ title: "error", label: "error", message: clean(plain[1]) }); continue; }
      const klog = line.match(KLOG_RE);
      if (klog) {
        // The klog line names a file inside client-go, which is not your code.
        push({ title: "error", label: "error", message: clean(klog[3]) });
      }
    }
    if (!failures.length) return null;
    // The plain-English line says the same thing as the klog lines above it, and says it
    // better, so lead with it when both are present.
    const plainFirst = failures.filter((f) => !/^"/.test(f.message));
    const kept = plainFirst.length ? plainFirst : failures;
    // The message doubles as the headline when it is short enough to be one; cutting a
    // long one mid-word says less than a count does.
    const lead = kept[0].message;
    return {
      tool: "kubectl",
      summary: lead.length <= 80 ? lead : `${kept.length} error${kept.length > 1 ? "s" : ""}`,
      failures: kept,
    };
  },
};
