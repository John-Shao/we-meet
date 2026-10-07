{{- define "work-agent-k8s.validate" -}}
{{- $a := .Values.workAgent -}}
{{- range $name := list $a.fullname $a.businessNamespace $a.tasks.namespace $a.tasks.serviceAccount $a.tasks.caConfigMap -}}
{{- if or (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $name)) (gt (len $name) 63) -}}{{- fail "Kubernetes agent resource names must be DNS labels" -}}{{- end -}}
{{- end -}}
{{- range $name := concat (list $a.tls.existingSecret $a.secrets.gatewaySecret) (compact (list $a.secrets.providerSecret $a.persistence.existingClaim)) -}}
{{- if or (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $name)) (gt (len $name) 63) -}}{{- fail "external Secret references must be DNS labels" -}}{{- end -}}
{{- end -}}
{{- range $secret := concat $a.imagePullSecrets $a.tasks.imagePullSecrets -}}
{{- if or (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $secret.name)) (gt (len $secret.name) 63) -}}{{- fail "image pull Secret references must be DNS labels" -}}{{- end -}}
{{- end -}}
{{- if gt (len $a.fullname) 57 -}}{{- fail "fullname is too long for a persistent claim name" -}}{{- end -}}
{{- if or (eq .Release.Namespace $a.businessNamespace) (eq $a.tasks.namespace $a.businessNamespace) (eq $a.tasks.namespace .Release.Namespace) -}}
{{- fail "gateway, task and business namespaces must be separate" -}}{{- end -}}
{{- if ne $a.runtime.execution "kubernetes" -}}{{- fail "this chart requires Kubernetes execution" -}}{{- end -}}
{{- if not (has $a.engine (list "pi" "dsh" "fixture")) -}}{{- fail "unsupported engine" -}}{{- end -}}
{{- if and (eq $a.engine "fixture") (not $a.testFixtureAcknowledged) -}}{{- fail "offline fixture requires explicit test acknowledgment" -}}{{- end -}}
{{- if not (has $a.provider (list "deepseek" "qwen")) -}}{{- fail "unsupported provider" -}}{{- end -}}
{{- if and (eq $a.engine "dsh") (ne $a.provider "deepseek") -}}{{- fail "dsh requires DeepSeek" -}}{{- end -}}
{{- if not (regexMatch "^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$" $a.baseUrl) -}}{{- fail "provider endpoint requires HTTPS" -}}{{- end -}}
{{- if or (not $a.image.repository) (hasPrefix "REPLACE_" $a.image.repository) (not (regexMatch "^sha256:[a-f0-9]{64}$" $a.image.digest)) -}}{{- fail "immutable gateway image required" -}}{{- end -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" $a.runtime.workerImage) -}}{{- fail "immutable worker image required" -}}{{- end -}}
{{- if not (regexMatch "^/var/lib/[A-Za-z0-9_-]+$" $a.runtime.stateDirectory) -}}{{- fail "dedicated gateway state directory required" -}}{{- end -}}
{{- if or (not $a.persistence.existingClaim) (hasPrefix "REPLACE_" $a.persistence.existingClaim) -}}
{{- if not $a.persistence.newStateAcknowledged -}}{{- fail "explicit existing PVC or new-state acknowledgment required" -}}{{- end -}}
{{- end -}}
{{- if or (not $a.tls.existingSecret) (hasPrefix "REPLACE_" $a.tls.existingSecret) -}}{{- fail "pre-provisioned gateway TLS Secret required" -}}{{- end -}}
{{- if or (not (contains "-----BEGIN CERTIFICATE-----" $a.tasks.publicCA)) (contains "PRIVATE KEY" $a.tasks.publicCA) -}}{{- fail "task trust must contain public CA certificates only" -}}{{- end -}}
{{- if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$" $a.tasks.apiServerCIDR) -}}{{- fail "single API server IPv4 /32 required" -}}{{- end -}}
{{- range $octet := splitList "." (trimSuffix "/32" $a.tasks.apiServerCIDR) -}}
{{- if or (gt (int $octet) 255) (and (gt (len $octet) 1) (hasPrefix "0" $octet)) -}}{{- fail "invalid API server IPv4 address" -}}{{- end -}}
{{- end -}}
{{- range $port := list $a.port $a.brokerPort $a.tasks.apiServerPort -}}
{{- if or (not (regexMatch "^[0-9]+$" (toString $port))) (lt (int $port) 1) (gt (int $port) 65535) -}}{{- fail "ports must be valid integers" -}}{{- end -}}
{{- end -}}
{{- if eq (int $a.port) (int $a.brokerPort) -}}{{- fail "gateway and broker ports must differ" -}}{{- end -}}
{{- if or $a.secrets.create $a.secrets.gatewayToken $a.secrets.deepseekApiKey $a.secrets.qwenApiKey -}}{{- fail "Kubernetes chart uses external Secrets only" -}}{{- end -}}
{{- if not $a.secrets.gatewaySecret -}}{{- fail "existing gateway token Secret required" -}}{{- end -}}
{{- if and (ne $a.engine "fixture") (not $a.secrets.providerSecret) -}}{{- fail "existing provider Secret required" -}}{{- end -}}
{{- end -}}

{{- define "work-agent-k8s.labels" -}}
app.kubernetes.io/name: {{ .Values.workAgent.fullname }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gateway
{{- end -}}
