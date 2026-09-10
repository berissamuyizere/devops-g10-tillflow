# infra/bootstrap — Terraform backend bootstrap

Creates the S3 bucket + DynamoDB table used as the Terraform remote
backend for the root module in `infra/`. Runs against a local backend
because it is bootstrapping the remote backend itself.

Run this **once per AWS account**, then never again.

## Prerequisites

- AWS credentials for the target account, region `eu-central-1`.
- Terraform ≥ 1.6.

## Steps

```bash
cd infra/bootstrap
terraform init
terraform apply
```

The apply will print the state bucket name (`devops-g10-tfstate-<acct>`)
and the lock table name (`devops-g10-tflock`). Copy the bucket name.

Then, from the repo root:

```bash
cd ../
# Point the root module at the bucket you just created.
terraform init \
  -backend-config="bucket=devops-g10-tfstate-<acct>" \
  -backend-config="dynamodb_table=devops-g10-tflock" \
  -backend-config="region=eu-central-1" \
  -backend-config="key=platform/terraform.tfstate"
```

From that point on, root-module apply is remote-state; do not touch
`infra/bootstrap/` again unless you are tearing the whole account down.

## Tear-down (G5 destroy/rebuild)

After `terraform destroy` in the root module:

```bash
cd infra/bootstrap
terraform destroy
```

The bucket has versioning on and DeletionPolicy=Retain, so this will
fail unless you empty the bucket first. That is intentional — losing
Terraform state is the worst thing that can happen to this repo.
