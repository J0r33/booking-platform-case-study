# Excerpt 10 — A deploy gate that refuses to pass when it checked nothing
#
# Before server functions deploy, this gate checks that every secret they need (payment keys,
# email keys, webhook signing keys) exists in the target environment. It reads the list of
# required secrets from a manifest file.
#
# What to notice:
#   * THE ANTI-HOLLOW GUARD. If the manifest is moved, truncated or mis-formatted, the
#     required list is empty, every loop below does nothing, and the script would print "all
#     checks passed". So an empty list FAILS, and the message says the gate is broken, not the
#     environment.
#   * The exit status of the secrets listing is captured explicitly. "Could not list secrets"
#     (bad token) and "secret is missing" (not provisioned) need different fixes, so they must
#     not look the same.
#   * stderr goes to a file, never into the text being searched, so a warning that happens to
#     mention a secret's name cannot make that secret look present.
#
# Lightly edited from production: a ticket reference removed, and a line printing part of the
# project id replaced.

# ANTI-HOLLOW GUARD. Every other failure in this file means "the environment is
# wrong". This one means "the gate is wrong", and it is first because a gate
# that checks nothing while printing a tick is the exact defect to remove. If
# the manifest moved, was truncated, lost its tabs, or had its last required
# entry deleted, `required` is empty and every loop below is a no-op that falls
# through to "all checks passed".
if [ "${#required[@]}" -eq 0 ]; then
  echo "✖ the manifest yielded ZERO required secrets for target '$TARGET'."
  echo "   That is not a pass — it means this gate would check nothing. Confirm"
  echo "   .function-secrets-manifest is intact and tab-separated."
  exit 1
fi

echo "— verifying Edge Function secrets (target: $TARGET)"
echo "  manifest expects ${#required[@]} required, ${#optional[@]} optional, ${#legacy[@]} legacy"

# --- Fetch the project's secret names ----------------------------------------
# The exit status is captured explicitly rather than left to `set -e`. Both a
# broken command and an empty store would otherwise report every secret as
# missing, and those two need different remedies: one is "provision the
# secret", the other is "your access token is wrong". Reporting the second as
# the first sends the operator to the wrong dashboard.
#
# stderr is captured to a FILE rather than folded into `listing` with `2>&1`.
# `listing` is the haystack every presence check greps, so anything merged into
# it can satisfy a check: a CLI that ever mentioned one of these names in a
# warning, a hint or a stack trace would make that secret look present. Only
# the command's real output is allowed to answer the question; stderr is for
# the diagnostic below and nothing else.
errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT

listing=""
list_status=0
listing="$("${secrets_list_cmd[@]}" 2>"$errfile")" || list_status=$?

if [ "$list_status" -ne 0 ]; then
  echo "✖ could not list secrets for this project (exit $list_status)."
  echo "   This gate proved NOTHING about the target environment — treat it as a"
  echo "   failed deploy, not a passed one. Usual causes: SUPABASE_ACCESS_TOKEN"
  echo "   missing or lacking access to this project, or a wrong project ref."
  # Safe to print: this command never receives a secret value, so its stderr
  # cannot contain one. It is the only thing that says WHICH of those causes.
  if [ -s "$errfile" ]; then
    echo "   The CLI said:"
    sed 's/^/     /' "$errfile"
  fi
  exit 1
fi
