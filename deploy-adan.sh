#!/bin/bash
echo "🚀 Deploying ADAN to Helsinki server..."
ssh root@157.180.115.216 "cd /root/adan-pred && git pull origin main && npm install && pm2 restart ADAN-MIND"
