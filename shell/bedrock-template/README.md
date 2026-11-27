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
- **Marketplace terms** (since 1.1.0). A Bedrock model sold through AWS
  Marketplace (Claude and OpenAI GPT, not gpt-oss) answers an account only
  once its terms are accepted. Bedrock's model-access page: "When you first
  invoke an Amazon Bedrock serverless model served from AWS Marketplace in
  an account, Bedrock attempts to automatically enable the model for your
  account. For this auto-enablement to work, AWS Marketplace permissions are
  required", namely `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe`
  and `aws-marketplace:ViewSubscriptions`. A 1.0.0 role's first call to such
  a model is refused with "... is not available for this account".
  - `Subscribe` and `Unsubscribe` are allowed only with a
    `ForAnyValue:StringEquals` condition on `aws-marketplace:ProductId`
    listing the product IDs in `Metadata.MarketplaceProductIds`, one per
    Bedrock model the app offers that is sold through AWS Marketplace, so the
    role cannot subscribe the account to any other Marketplace product, paid
    or not. Each ID is the "Marketplace product ID" on the model's card
    (models at a glance,
    https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html,
    read 2026-11-27).
  - `ViewSubscriptions` is allowed on `*` with no condition: it only lists
    the account's subscriptions, and no page says it takes a product
    condition.
  - What is not yet proven: Bedrock's model-access page says "For the
    `aws-marketplace:Subscribe` action only, you can use the
    `aws-marketplace:ProductId` condition key to restrict subscription to
    specific models", but the service authorization reference
    (https://docs.aws.amazon.com/service-authorization/latest/reference/list_awsmarketplace.html)
    lists no condition key for `Subscribe`, `Unsubscribe` or
    `ViewSubscriptions`, and no page says the condition holds for Bedrock's
    automatic first-call subscription. A key absent from a request makes the
    condition false, so at worst the role is refused the subscription, as a
    1.0.0 role is, and never allowed more. The first live GPT-5.5 call
    through a 1.1.0 role settles it. Pages read 2026-11-27.
  - Models AWS sells itself (Amazon Nova, and the other providers
    `notMarketplace` in `src/providers/bedrock-models.json` names) need none
    of this, so a 1.0.0 role still connects and runs the Connect test call.
- **Reading each model's access state** (since 1.2.0), for "Refresh model
  list" on the Connect screen (`src/providers/bedrock-account.ts`):
  `bedrock:GetFoundationModelAvailability` (a model's Marketplace agreement,
  authorization, entitlement and region availability in this account) and
  `bedrock:GetUseCaseForModelAccess` (whether Anthropic's one-time use-case
  form was filled), both on `*`. The service authorization reference lists
  both as Read actions with no resource type and no condition key
  (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html,
  read 2026-11-27): "Grants permission to get the availability of a
  foundation model" and "Grants permission to retrieve a use case for model
  access". Neither changes anything in the account. A 1.1.0 role is refused
  them, so its states show as unknown with a note to update the stack; it
  still connects and its models are still chosen and tested as before. The
  1.1.0 Marketplace statement is unchanged.
- **Sessions** of one hour at most (role chaining caps them there anyway).

Deleting the stack deletes the role: that is how a user revokes the app.

## Compatibility and releases

Users' stacks keep the version they were made with, and are never updated by
the app. So every new version must keep working with older stacks: the role
name, the two parameters and the `RoleArn` and `TemplateVersion` outputs stay
as they are, and the app must not need a permission an older role lacks.
A user whose older stack lacks a later permission is told to update the
stack to the new template (in AWS CloudFormation: Update, then Replace
existing template), never to create it again: the app reads the version
from the stack (`TemplateVersion` output), and a model refused for want of
Marketplace terms on a stack older than 1.1.0 (`MARKETPLACE_TERMS_SINCE` in
`src/providers/bedrock.ts`) shows that update.

**A new Marketplace-sold model needs a new version.** The product list is
fixed in each published version, so a model sold through AWS Marketplace
that Bedrock starts offering is refused its first call until its product ID
is added to `Metadata.MarketplaceProductIds` and to the condition, and
`TemplateVersion` is raised (the release workflow refuses to publish changed
content under a published version). `test/bedrock-catalog.test.ts` fails
when a model the app offers from the saved model list is sold through AWS
Marketplace and its product ID is not in the template. Users then update
their stacks to the new version, the same way.

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
