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
- **Marketplace terms** (since 1.1.0): `aws-marketplace:Subscribe`,
  `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions`, the
  three actions Bedrock's model-access page names for a serverless model
  sold through AWS Marketplace (Anthropic's, for example): "When you first
  invoke an Amazon Bedrock serverless model served from AWS Marketplace in
  an account, Bedrock attempts to automatically enable the model for your
  account. For this auto-enablement to work, AWS Marketplace permissions are
  required." Without them a 1.0.0 role's first call to such a model is
  refused with "... is not available for this account". They are granted on
  `*`, not narrowed to products: AWS Marketplace "does not support
  specifying a resource ARN" (service authorization reference), and while
  Bedrock's page says `aws-marketplace:ProductId` can restrict `Subscribe`,
  the service authorization reference lists no condition key for
  `Subscribe`, no page says the condition holds for Bedrock's automatic
  first-call subscription, and a fixed product list would refuse every model
  added later (pages read 2026-11-27:
  https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html,
  https://docs.aws.amazon.com/service-authorization/latest/reference/list_awsmarketplace.html).
  No other Marketplace or IAM action is granted. Models AWS sells itself
  (Amazon Nova, and the other providers that page lists as not sold through
  AWS Marketplace) need none of the three, so a 1.0.0 role still connects
  and runs the Connect test call.
- **Sessions** of one hour at most (role chaining caps them there anyway).

Deleting the stack deletes the role: that is how a user revokes the app.

## Compatibility and releases

Users' stacks keep the version they were made with, and are never updated by
the app. So every new version must keep working with older stacks: the role
name, the two parameters and the `RoleArn` and `TemplateVersion` outputs stay
as they are, and the app must not need a permission an older role lacks.
A user whose older stack lacks a later permission is told to update the
stack to the new template (in CloudFormation: Update, then Replace existing
template), never to create it again.

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
