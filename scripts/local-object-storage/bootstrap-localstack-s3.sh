#!/bin/sh

set -eu

bucket="${AWS_S3_BUCKET:-cinderdeck-s3-local}"
region="${AWS_DEFAULT_REGION:-us-east-1}"

if awslocal s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  echo "Bucket $bucket already exists"
else
  if [ "$region" = "us-east-1" ]; then
    awslocal s3api create-bucket --bucket "$bucket"
  else
    awslocal s3api create-bucket \
      --bucket "$bucket" \
      --create-bucket-configuration "LocationConstraint=$region"
  fi
fi

awslocal s3api put-public-access-block \
  --bucket "$bucket" \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false" \
  >/dev/null 2>&1 || true

policy=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$bucket/*"]
    }
  ]
}
EOF
)

awslocal s3api put-bucket-policy \
  --bucket "$bucket" \
  --policy "$policy"

echo "LocalStack S3 bucket ready: $bucket"
