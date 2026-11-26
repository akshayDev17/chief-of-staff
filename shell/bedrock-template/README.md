# The Bedrock role template (T16, design-v3 1.4, ADR-017)

`template.json` is the CloudFormation template a user's "Connect Amazon
Bedrock" quick-create link opens. It is its own release unit, with its own
version (`Metadata.TemplateVersion` and the `TemplateVersion` output, kept
equal; the tests check both).

It makes one role, `chief-of-staff-model-caller`, in the user's own AWS
account:

- **Trust**: only the app's own role (`AppRoleArn`), and only with the
  user's external ID (`ExternalId`), AWS's documented pattern for a third
  party. Both parameters arrive filled in from the app's link.
- **Permissions**: `bedrock:InvokeModel` and
  `bedrock:InvokeModelWithResponseStream` (which also cover Converse and
  ConverseStream) on foundation models and inference profiles, and
  `cloudformation:DescribeStacks` on its own stack only, so the app can read
  which template version the user's stack was made with.
- **Sessions** of one hour at most (role chaining caps them there anyway).

Deleting the stack deletes the role: that is how a user revokes the app.

## Compatibility and releases

Users' stacks keep the version they were made with, and are never updated by
the app. So every new version must keep working with older stacks: the role
name, the two parameters and the `RoleArn` and `TemplateVersion` outputs stay
as they are, and the app must not need a permission an older role lacks.

`.github/workflows/release-bedrock-template.yml` publishes each version, on a
push to `main` that changes this directory, to
`s3://<bucket>/chief-of-staff-bedrock-role/v<version>.json` and never
overwrites a published version. The Worker variable `BEDROCK_TEMPLATE_URL`
(set in the GitHub environment `production`; `shell/src/providers/README.md`)
names the version the link opens. **Rollback**: point `BEDROCK_TEMPLATE_URL`
back at the previous version's address. The workflow stops with a plain
message until T10's AWS values exist (`BEDROCK_TEMPLATE_BUCKET` and
`BEDROCK_PUBLISH_ROLE_ARN`). The bucket is in `us-east-1`, the region the
workflow uses. The publish role trusts only this repository's `main`
branch, with audience `sts.amazonaws.com` and the subject in the immutable
form GitHub issues for this repository,
`repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/main`; the
sub_claim_prefix printed by
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` gives the two
IDs, and `provider-setup.mjs values` prints the whole policy.
