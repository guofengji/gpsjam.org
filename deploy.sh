#!/bin/bash
set -e

ssh bitnami@gpsjam.org << EOF
  cd /home/bitnami/gpsjam.org
  git pull
  npm install
  pm2 restart app
EOF
