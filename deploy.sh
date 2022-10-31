#!/bin/bash
set -e

ssh -Y gpsjam@gpsjam.org << EOF
  cd ~/gpsjam.org &&
  git pull &&
  npm install &&
  pm2 restart app
EOF
