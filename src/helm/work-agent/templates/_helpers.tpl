{{- define "work-agent.name" -}}
{{- .Values.workAgent.fullname -}}
{{- end -}}

{{- define "work-agent.labels" -}}
app.kubernetes.io/name: work-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gateway
{{- end -}}

{{- define "work-agent.validate" -}}
{{- $agent := .Values.workAgent -}}
{{- if not (regexMatch "^[0-9]+$" (toString $agent.port)) -}}{{- fail "workAgent.port must be an integer" -}}{{- end -}}
{{- if or (lt (int $agent.port) 1) (gt (int $agent.port) 65535) -}}{{- fail "workAgent.port is out of range" -}}{{- end -}}
{{- if not $agent.runtime.dedicatedNodeAcknowledged -}}
{{- fail "workAgent requires acknowledgment of a dedicated Docker runner node" -}}
{{- end -}}
{{- if or (not $agent.runtime.nodeHostname) (hasPrefix "REPLACE_" $agent.runtime.nodeHostname) -}}
{{- fail "workAgent requires runtime.nodeHostname pinned to the dedicated node" -}}
{{- end -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $agent.fullname) -}}
{{- fail "workAgent.fullname must be a DNS label" -}}
{{- end -}}
{{- if gt (len $agent.fullname) 63 -}}{{- fail "workAgent.fullname is too long" -}}{{- end -}}
{{- if not (has $agent.engine (list "dsh" "pi")) -}}{{- fail "workAgent.engine must be dsh or pi" -}}{{- end -}}
{{- if not (has $agent.provider (list "deepseek" "qwen")) -}}{{- fail "workAgent.provider must be deepseek or qwen" -}}{{- end -}}
{{- if and (eq $agent.engine "dsh") (ne $agent.provider "deepseek") -}}{{- fail "dsh requires the DeepSeek provider" -}}{{- end -}}
{{- if and (eq $agent.provider "qwen") (eq $agent.model "deepseek-flash") -}}{{- fail "Qwen requires an explicit Qwen model" -}}{{- end -}}
{{- if and $agent.baseUrl (not (regexMatch "^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$" $agent.baseUrl)) -}}{{- fail "provider baseUrl must be HTTPS without credentials or query" -}}{{- end -}}
{{- if or (not $agent.image.repository) (hasPrefix "REPLACE_" $agent.image.repository) (not (regexMatch "^sha256:[a-f0-9]{64}$" $agent.image.digest)) -}}
{{- fail "workAgent requires an immutable gateway image repository and SHA-256 digest" -}}
{{- end -}}
{{- if not (regexMatch "^[^[:space:]]+@sha256:[a-f0-9]{64}$" $agent.runtime.workerImage) -}}
{{- fail "workAgent requires an immutable runtime.workerImage repo@sha256 digest" -}}
{{- end -}}
{{- if or (not $agent.tls.existingSecret) (hasPrefix "REPLACE_" $agent.tls.existingSecret) -}}
{{- fail "workAgent requires a pre-provisioned TLS Secret" -}}
{{- end -}}
{{- if not (regexMatch "^/var/lib/[a-zA-Z0-9_-]+$" $agent.runtime.stateDirectory) -}}
{{- fail "workAgent stateDirectory must be a dedicated directory directly under /var/lib" -}}
{{- end -}}
{{- if ne $agent.runtime.dockerSocket "/var/run/docker.sock" -}}
{{- fail "workAgent only supports the dedicated node's /var/run/docker.sock" -}}
{{- end -}}
{{- if or (not $agent.secrets.gatewaySecret) (not $agent.secrets.clientSecret) (eq $agent.secrets.gatewaySecret $agent.secrets.clientSecret) -}}
{{- fail "workAgent requires separate gateway and client Secret names" -}}
{{- end -}}
{{- if $agent.secrets.providerSecret -}}
{{- if or (eq $agent.secrets.providerSecret $agent.secrets.gatewaySecret) (eq $agent.secrets.providerSecret $agent.secrets.clientSecret) -}}
{{- fail "existing providerSecret must be separate from managed gateway/client Secrets" -}}
{{- end -}}
{{- if or (not (regexMatch "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$" $agent.secrets.providerSecret)) (gt (len $agent.secrets.providerSecret) 253) -}}
{{- fail "workAgent providerSecret must be a Kubernetes Secret name" -}}
{{- end -}}
{{- if or $agent.secrets.deepseekApiKey $agent.secrets.qwenApiKey -}}
{{- fail "existing providerSecret mode must not contain literal provider keys" -}}
{{- end -}}
{{- end -}}
{{- if $agent.secrets.create -}}
{{- if or (lt (len $agent.secrets.gatewayToken) 24) (hasPrefix "REPLACE_" $agent.secrets.gatewayToken) -}}
{{- fail "workAgent requires a fresh gatewayToken with at least 24 characters" -}}
{{- end -}}
{{- if not $agent.secrets.providerSecret -}}
{{- $providerKey := ternary $agent.secrets.qwenApiKey $agent.secrets.deepseekApiKey (eq $agent.provider "qwen") -}}
{{- if not (regexMatch "^sk-[A-Za-z0-9_-]{16,200}$" $providerKey) -}}
{{- fail "workAgent requires a production provider key; PoC credentials are not copied" -}}
{{- end -}}
{{- end -}}
{{- else if or $agent.secrets.gatewayToken $agent.secrets.deepseekApiKey $agent.secrets.qwenApiKey -}}
{{- fail "workAgent external Secret mode must not contain literal credentials" -}}
{{- end -}}
{{- end -}}
