#!/usr/bin/env bash
# Launch the Attessa seller host (SPEC §5, ADR-008): one c6g.xlarge in us-east-1 with Nitro Enclaves on,
# Amazon Linux 2023 arm64, a security group, an Elastic IP.
#   ./scripts/ec2-launch.sh <key-pair-name> <ssh-cidr>          prints every command, runs none
#   ./scripts/ec2-launch.sh <key-pair-name> <ssh-cidr> --run    runs them (this creates billable resources)
# <ssh-cidr> is where you SSH from, e.g. 203.0.113.7/32. Opens only 22 (that CIDR), 80 and 443. Never the
# gateway, seller-host, socat or enclave ports: Caddy on 443 is the only way in.
# Reads no credential itself; the AWS CLI finds yours. Not yet run on a real account.
set -euo pipefail
REGION=us-east-1
TYPE=c6g.xlarge
NAME=attessa-seller
AMI_PARAM=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64
[ $# -ge 2 ] && [ $# -le 3 ] || { sed -n 2,9p "$0"; exit 2; }
KEY=$1 CIDR=$2 RUN=${3:-}
[ -z "$RUN" ] || [ "$RUN" = --run ] || { echo "third argument must be --run"; exit 2; }
[[ $KEY =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad key pair name"; exit 2; }
[[ $CIDR =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || { echo "bad CIDR: $CIDR"; exit 2; }
[ "${CIDR#*/}" != 0 ] || { echo "refusing a /0 for SSH"; exit 2; }

if [ "$RUN" = --run ]; then
  aws() { command aws --region "$REGION" "$@"; }
  echo "== running (region $REGION)"
else
  # Print mode: the commands that need a result print a <placeholder> for it.
  aws() {
    {
      printf 'aws --region %s' "$REGION"
      for a in "$@"; do if [[ $a =~ ^[A-Za-z0-9_./=:,@-]+$ ]]; then printf ' %s' "$a"; else printf " '%s'" "$a"; fi; done
      echo
    } >&2
  }
fi
# val <placeholder> <aws args...>: the command's text output when running, the placeholder when printing.
val() { local p=$1; shift; if [ "$RUN" = --run ]; then aws "$@"; else aws "$@"; echo "<$p>"; fi; }

AMI=$(val ami ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)
SG=$(val sg-id ec2 create-security-group --group-name "$NAME" --description "Attessa seller host" --query GroupId --output text)
ingress() { aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port "$1" --cidr "$2"; }
ingress 22 "$CIDR"
ingress 80 0.0.0.0/0
ingress 443 0.0.0.0/0
ID=$(val instance-id ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY" \
  --security-group-ids "$SG" --enclave-options Enabled=true --metadata-options HttpTokens=required \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$ID"
ALLOC=$(val allocation-id ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC"
IP=$(val elastic-ip ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
echo "instance $ID, Elastic IP $IP"
echo "next: make a DNS A record for your seller subdomain pointing at $IP, then ssh -i <key.pem> ec2-user@$IP"
