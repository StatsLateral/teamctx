# Removing a file attached by mistake

A file attached as a task output goes into the project's own git repository.
Once it is committed, removing the task or the output **does not** remove the
file: it stays in the repository's history, and anyone who has already pulled
the repository still has it.

teamctx scans text uploads (`.txt`, `.md`, `.csv`, `.json`) for obvious secrets
and refuses one that looks like it carries a key or token, so most mistakes are
stopped before they land. This page is for when something got through — because
it was a type that is not scanned, because the scan did not recognise it, or
because it was attached with the override.

## If it was a secret, rotate it first

This is the real fix. Removing the file from history does not un-leak a
credential that was pushed — treat it as exposed and **rotate it** (issue a new
key, revoke the old one). Do this before, and regardless of, any history
cleanup.

## Remove the file

1. **Remove the output** so it is no longer part of the task. The file stays in
   history until the next step.
2. **Rewrite history with [git-filter-repo](https://github.com/newren/git-filter-repo)**
   (the maintained replacement for `filter-branch`). This is destructive and
   rewrites commit ids, so coordinate with anyone else working on the repository.

   ```sh
   # from a fresh clone of the project repository
   git filter-repo --path outputs/<task-id>/files/<the-file> --invert-paths
   git push --force origin main
   ```

   Replace the path with the one the file was stored at (the output records its
   `file.path`). `--invert-paths` keeps everything *except* that path.

3. **Everyone re-clones.** A force-pushed history means existing clones no longer
   match; the simplest safe step for collaborators is a fresh clone.

## Notes

- teamctx ships no command that rewrites history on your behalf: it is
  destructive and specific to your repository, so it is left to `git-filter-repo`
  run deliberately by you.
- If the exposure is in a public repository, assume it was indexed the moment it
  was pushed. Rotation is not optional.
