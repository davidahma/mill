# GitHub repository settings

The active public source repository is
[davidahma/mill](https://github.com/davidahma/mill). Its single
[CI workflow](../.github/workflows/ci.yml) runs for pull requests and pushes to
`main`. It has read-only repository permissions, checks out code without stored
credentials and uses GitHub-hosted Linux workers.

When configuring protection for `main`:

- Require pull requests, resolution of review conversations and passing
  `validate`, `pnpm-oci` and `python-oci` checks from GitHub Actions.
- Require branches to be up to date before merging. Keep default-branch deletion
  and force pushes disabled.
- Use squash merging for one coherent change and delete feature branches when
  they merge.
- Route review via [CODEOWNERS](../.github/CODEOWNERS). The maintainer still
  records an independent exact-candidate review where delivery risk warrants it.
  Requiring the sole maintainer to approve their own PR would deadlock.

Check names here describe CI. Each downstream repository owns its own delivery
policy and requirements. Configure exact producer identity before enabling
[attended merge](approvals.md). Optional `propose.postMergeRequiredChecks` must
be a nonempty subset of the pre-merge list and account for checks that only run
on a pull request. Any source or external publication needs separate maintainer
approval.
