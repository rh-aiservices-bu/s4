# Troubleshooting Guide

Common issues and solutions for S4.

## Container Issues

### Container Won't Start

**Symptoms**:

- Container exits immediately
- `podman ps` doesn't show s4 container

**Diagnosis**:

```bash
# Check container logs
podman logs s4

# Check container status
podman ps -a | grep s4

# Inspect container
podman inspect s4
```

**Common Causes**:

1. **Ports already in use**:

```bash
# Check if ports are occupied
sudo lsof -i :5000
sudo lsof -i :7480

# Kill process using port
sudo kill -9 <PID>

# Or use different ports
podman run -d --name s4 -p 8080:5000 -p 8480:7480 ...
```

2. **Volume permission issues**:

```bash
# For rootless podman
podman unshare chown -R 0:0 /data/s4/rgw
podman unshare chown -R 0:0 /data/s4/storage

# Or run with user namespace mapping
podman run -d --name s4 --userns=keep-id ...
```

3. **Missing environment variables**:

```bash
# Check env vars
podman exec s4 env | grep AWS

# Verify required vars are set
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
```

### Container Keeps Restarting

**Symptoms**:

- Container in CrashLoopBackOff state
- Logs show repeated startup/shutdown

**Diagnosis**:

```bash
# View recent crashes
podman events --filter container=s4

# Check restart count
podman inspect s4 | grep -i restart

# View exit code
podman inspect s4 | grep -i exitcode
```

**Solutions**:

1. **Increase memory limit**:

```bash
podman run -d --name s4 --memory 4g ...
```

2. **Check health probe settings** (Kubernetes):

```yaml
# Increase initial delay
livenessProbe:
  initialDelaySeconds: 120 # Increase if slow startup
```

3. **Review logs for errors**:

```bash
podman logs s4 --tail 100
```

## Kubernetes/OpenShift Issues

### Pod Not Starting

**Symptoms**:

- Pod stuck in Pending state
- Pod shows ImagePullBackOff or ErrImagePull

**Diagnosis**:

```bash
# Check pod status
kubectl get pods -l app=s4

# Describe pod for events
kubectl describe pod <s4-pod>

# Check events
kubectl get events --field-selector involvedObject.name=<s4-pod>
```

**Common Causes**:

1. **ImagePullBackOff**:

```bash
# Check image name
kubectl get pod <s4-pod> -o jsonpath='{.spec.containers[0].image}'

# Verify image exists
podman pull quay.io/rh-aiservices-bu/s4:latest

# Check image pull secrets (if private registry)
kubectl get secrets

# Fix: Update deployment with correct image
kubectl set image deployment/s4 s4=quay.io/rh-aiservices-bu/s4:v1.0.0
```

2. **Insufficient Resources**:

```bash
# Check node resources
kubectl describe nodes | grep -A 5 "Allocated resources"

# Reduce resource requests
kubectl edit deployment s4
# Adjust: resources.requests.memory and resources.requests.cpu
```

3. **PVC Not Binding**:

```bash
# Check PVC status
kubectl get pvc

# If Pending, check storage class
kubectl get storageclass

# Describe PVC for details
kubectl describe pvc s4-data
```

### Pod Running But Not Ready

**Symptoms**:

- Pod shows 0/1 Ready
- Service not routing traffic

**Diagnosis**:

```bash
# Check readiness probe
kubectl describe pod <s4-pod> | grep -A 10 Readiness

# Test endpoint manually
kubectl exec <s4-pod> -- curl -f http://localhost:5000/api/disclaimer
```

**Solutions**:

1. **Increase readiness probe delay**:

```yaml
readinessProbe:
  initialDelaySeconds: 30 # Increase if slow startup
  periodSeconds: 10
```

2. **Check application logs**:

```bash
kubectl logs <s4-pod>
```

### Service Not Accessible

**Symptoms**:

- Cannot access S4 via service
- Connection refused or timeout

**Diagnosis**:

```bash
# Check service exists
kubectl get svc s4

# Check endpoints
kubectl get endpoints s4

# If no endpoints, pods aren't ready
kubectl get pods -l app=s4

# Test from another pod
kubectl run -it --rm debug --image=alpine --restart=Never -- sh
# Inside pod:
wget -O- http://s4:5000/
```

**Solutions**:

1. **Fix selector mismatch**:

```bash
# Check service selector
kubectl get svc s4 -o yaml | grep -A 3 selector

# Check pod labels
kubectl get pod <s4-pod> -o yaml | grep -A 3 labels

# Ensure they match
```

2. **Check network policies**:

```bash
kubectl get networkpolicies
kubectl describe networkpolicy <policy-name>
```

## Application Issues

### Authentication Not Working

**Symptoms**:

- Can't log in
- Always redirected to login page
- API returns 401 Unauthorized

**Diagnosis**:

```bash
# Check auth status
curl http://localhost:5000/api/auth/info

# Expected response (auth enabled):
# {"authMode":"simple","authRequired":true}

# Check credentials are set
kubectl get secret s4-credentials -o jsonpath='{.data.UI_USERNAME}' | base64 -d
kubectl get secret s4-credentials -o jsonpath='{.data.UI_PASSWORD}' | base64 -d
```

**Solutions**:

1. **Credentials not set**:

```bash
# Set credentials
kubectl create secret generic s4-credentials \
  --from-literal=UI_USERNAME=admin \
  --from-literal=UI_PASSWORD=pass \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart deployment
kubectl rollout restart deployment/s4
```

2. **JWT secret mismatch** (multi-replica):

```bash
# Ensure JWT_SECRET is set in Secret
kubectl get secret s4-credentials -o jsonpath='{.data.JWT_SECRET}' | base64 -d

# If missing, set it
kubectl patch secret s4-credentials -p '{"stringData":{"JWT_SECRET":"shared-secret"}}'
kubectl rollout restart deployment/s4
```

### S3 Connection Failed

**Symptoms**:

- "Failed to connect to S3" errors
- Buckets not loading
- Upload/download fails

**Diagnosis**:

```bash
# Test S3 endpoint
curl -v http://localhost:7480/

# Check RGW logs
kubectl logs <s4-pod> | grep -i rgw

# Test with AWS CLI
aws s3 ls --endpoint-url http://localhost:7480
```

**Solutions**:

1. **RGW not running**:

```bash
# Check RGW process
kubectl exec <s4-pod> -- ps -ef | grep rgw-standalone

# Check supervision messages (restarts, give-ups)
kubectl logs <s4-pod> | grep entrypoint

# If the entrypoint gave up, restart the pod
kubectl delete pod <s4-pod>
```

2. **Incorrect credentials**:

```bash
# Verify S3 credentials match between backend and RGW
kubectl get secret s4-credentials -o yaml

# Test with correct credentials
export AWS_ACCESS_KEY_ID=s4admin
export AWS_SECRET_ACCESS_KEY=s4secret
aws s3 ls --endpoint-url http://localhost:7480
```

3. **External S3 configured but unreachable**:

```bash
# Check if external S3 is configured
kubectl get configmap s4-config -o yaml | grep AWS_S3_ENDPOINT

# Test external endpoint
curl -v https://s3.amazonaws.com/
```

### Upload/Download Fails

**Symptoms**:

- File upload hangs or fails
- Download produces corrupted files
- "Request Entity Too Large" errors

**Diagnosis**:

```bash
# Check backend logs
kubectl logs <s4-pod> | grep -i upload
kubectl logs <s4-pod> | grep -i download

# Check file size limit
kubectl get configmap s4-config -o yaml | grep MAX_FILE_SIZE_GB
```

**Solutions**:

1. **File too large**:

```bash
# Increase max file size
kubectl edit configmap s4-config
# Set MAX_FILE_SIZE_GB: "50"

kubectl rollout restart deployment/s4
```

2. **Network timeout**:

```bash
# Increase timeout in reverse proxy/ingress
# For Nginx:
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

3. **Disk full**:

```bash
# Check PVC usage
kubectl exec <s4-pod> -- df -h /var/lib/ceph/radosgw

# Expand PVC if needed
kubectl edit pvc s4-data
# Increase: spec.resources.requests.storage
```

## Notification / Webhook Issues

### Webhooks Not Firing

**Symptoms**:

- Webhook endpoint not receiving any requests
- No notification-related entries in logs

**Diagnosis**:

```bash
# Check notification configuration exists
curl http://localhost:5000/api/notifications/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Test endpoint reachability from S4
curl -X POST http://localhost:5000/api/notifications/test-endpoint \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "https://example.com/webhook"}'

# Check S4 logs for webhook dispatch errors
kubectl logs <s4-pod> | grep -i webhook
kubectl logs <s4-pod> | grep -i notification

# Verify bucket directory exists on disk
kubectl exec <s4-pod> -- ls -la /var/lib/ceph/radosgw/buckets/my-bucket
```

**Common Causes**:

1. **Bucket directory does not exist** - The filesystem watcher requires the bucket data directory to exist at `BUCKET_DATA_PATH/<bucketName>`. If the bucket was created on an external S3 or the path is misconfigured, the watcher cannot start.

2. **Endpoint unreachable from S4** - The webhook URL must be reachable from the S4 container. Use the test endpoint feature to verify.

3. **Restrictive filters** - Prefix and suffix filters may be too narrow. Check that your object keys match the configured filters.

4. **Debounce delay** - Events are debounced with a 200ms delay. Very rapid changes may be collapsed into a single event.

5. **Dotfiles ignored** - Files starting with `.` (hidden files, editor temp files) are intentionally filtered out and do not trigger notifications.

### Webhook Receiving Unexpected Events

**Symptoms**:

- Receiving more events than expected
- Duplicate or unexpected event types

**Solutions**:

1. **Add filters** - Use prefix and suffix filters to narrow which objects trigger notifications

2. **Editor temp files** - Some editors create temporary files during save operations (e.g., `file.txt~`, `file.txt.swp`). While dotfiles are filtered, non-dot temp files may trigger events. Use suffix filters to target specific file types.

3. **Debounce** - A single save operation may generate multiple filesystem events (create + modify). The 200ms debounce handles most cases, but some edge cases may slip through.

### Notifications Lost After Restart

**Symptoms**:

- Notification configurations disappear after S4 restarts
- Webhooks stop firing after restart

**Diagnosis**:

```bash
# Check if notification store file exists and has content
kubectl exec <s4-pod> -- cat /var/lib/ceph/radosgw/db/notifications.json

# Check file permissions
kubectl exec <s4-pod> -- ls -la /var/lib/ceph/radosgw/db/notifications.json

# Check if the storage path is on a persistent volume
kubectl describe pod <s4-pod> | grep -A 5 "Mounts"
```

**Solutions**:

1. **Mount persistent storage** - Ensure `/var/lib/ceph/radosgw/db/` is backed by a PersistentVolumeClaim. Without persistent storage, the notification configuration file is lost on restart.

2. **Check file permissions** - The S4 process must have read/write access to the `NOTIFICATION_STORE_PATH` directory.

### Test Endpoint Fails but Webhook Works (or Vice Versa)

**Symptoms**:

- Test endpoint returns failure but actual webhooks are delivered successfully
- Test endpoint succeeds but real events are not received

**Solutions**:

1. **Event type filtering** - The test endpoint sends `s3:TestEvent`, which is a special event type. Your webhook receiver may filter or handle it differently than production events like `s3:ObjectCreated:Put`.

2. **Network intermittency** - The test and production webhooks use the same 5-second timeout. Network conditions may vary between test time and event time.

3. **Endpoint routing** - Some webhook receivers route based on the `eventName` field. Ensure your receiver accepts both `s3:TestEvent` and the production event types you configured.

## Performance Issues

### High Memory Usage

**Symptoms**:

- OOMKilled events
- Pod restarts frequently
- Slow response times

**Diagnosis**:

```bash
# Check memory usage
kubectl top pod <s4-pod>

# Check OOM events
kubectl get events | grep OOM

# View memory limits
kubectl describe pod <s4-pod> | grep -A 5 Limits
```

**Solutions**:

1. **Increase memory limits**:

```yaml
resources:
  requests:
    memory: '1Gi'
  limits:
    memory: '4Gi'
```

2. **Reduce concurrent transfers**:

```bash
# Lower MAX_CONCURRENT_TRANSFERS
kubectl edit configmap s4-config
# Set MAX_CONCURRENT_TRANSFERS: "1"
```

### Slow Response Times

**Symptoms**:

- UI loads slowly
- API requests timeout
- File operations take too long

**Diagnosis**:

```bash
# Check CPU usage
kubectl top pod <s4-pod>

# Check backend logs for slow requests
kubectl logs <s4-pod> | grep "responseTime"

# Check if hitting resource limits
kubectl describe pod <s4-pod> | grep -i throttl
```

**Solutions**:

1. **Increase CPU limits**:

```yaml
resources:
  requests:
    cpu: '500m'
  limits:
    cpu: '2000m'
```

2. **Scale horizontally** (if using external S3):

```bash
kubectl scale deployment/s4 --replicas=3
```

3. **Use faster storage**:

```bash
# Switch to SSD storage class
kubectl edit pvc s4-data
# Change: spec.storageClassName: "fast-ssd"
```

## Network Issues

### Cannot Access Web UI

**Symptoms**:

- Browser shows "Connection refused"
- Timeout when accessing URL

**Diagnosis**:

```bash
# Check service
kubectl get svc s4

# Check ingress
kubectl get ingress s4

# Check if pod is ready
kubectl get pods -l app=s4

# Test from within cluster
kubectl run -it --rm debug --image=alpine --restart=Never -- wget -O- http://s4:5000/
```

**Solutions**:

1. **Port forwarding** (temporary):

```bash
kubectl port-forward svc/s4 5000:5000
# Access at http://localhost:5000
```

2. **Fix ingress/route**:

```bash
# OpenShift - create route
oc expose svc/s4

# Kubernetes - check ingress
kubectl describe ingress s4
```

### CORS Errors

**Symptoms**:

- Browser console shows CORS errors
- "Access-Control-Allow-Origin" errors

**Diagnosis**:

```bash
# Check ALLOWED_ORIGINS setting
kubectl get configmap s4-config -o yaml | grep ALLOWED_ORIGINS
```

**Solutions**:

```bash
# Update allowed origins
kubectl edit configmap s4-config
# Set ALLOWED_ORIGINS: "https://s4.example.com,https://app.example.com"

kubectl rollout restart deployment/s4
```

## Data Issues

### Lost Data After Restart

**Symptoms**:

- Buckets/objects disappear after pod restart
- S4 appears empty

**Diagnosis**:

```bash
# Check if PVCs are bound
kubectl get pvc

# Check PV exists
kubectl get pv

# Check if volume mounted
kubectl describe pod <s4-pod> | grep -A 5 Mounts
```

**Solutions**:

1. **PVC not created**:

```bash
kubectl apply -f kubernetes/s4-pvc.yaml
kubectl rollout restart deployment/s4
```

2. **Using emptyDir** (ephemeral):

```yaml
# Fix: Change from emptyDir to PVC
volumes:
  - name: s4-data
    persistentVolumeClaim:
      claimName: s4-data
```

## Debugging Commands

### Container

```bash
# Shell into container
podman exec -it s4 /bin/bash

# Check processes
podman top s4

# Check resource usage
podman stats s4

# View container configuration
podman inspect s4 | jq
```

### Kubernetes

```bash
# Shell into pod
kubectl exec -it <s4-pod> -- /bin/bash

# Check processes
kubectl exec <s4-pod> -- ps aux

# Save container logs
kubectl logs <s4-pod> > s4.log

# Port forward for debugging
kubectl port-forward <s4-pod> 5000:5000 7480:7480
```

## Getting Help

If issues persist:

1. **Gather Information**:

   - Pod/container logs
   - Event logs
   - Configuration (Secret, ConfigMap)
   - Resource usage

2. **Check Documentation**:

   - [FAQ](./faq.md)
   - [GitHub Issues](https://github.com/rh-aiservices-bu/s4/issues)

3. **Create Issue**:
   - Describe problem
   - Include logs and configuration
   - List troubleshooting steps attempted

## Related Documentation

- [Monitoring](./monitoring.md) - Monitoring and observability
- [FAQ](./faq.md) - Frequently asked questions
- [Configuration](../deployment/configuration.md) - Environment variables
- [Production Readiness](../deployment/production-readiness.md) - Production checklist
