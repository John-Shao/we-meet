package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	CSRFCookieName = "work_csrf"
	CSRFHeaderName = "X-CSRF-Token"
	csrfVersion    = "v1"
)

var ErrCSRFInvalid = errors.New("csrf_invalid")

type CSRF struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

type csrfPayload struct {
	Subject string `json:"sub"`
	Org     string `json:"org"`
	Rev     int64  `json:"rev"`
	Expires int64  `json:"exp"`
}

func NewCSRF(secret []byte, ttl time.Duration, now func() time.Time) (*CSRF, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("csrf secret must be at least 32 bytes")
	}
	if ttl <= 0 {
		ttl = time.Hour
	}
	if now == nil {
		now = time.Now
	}
	copied := append([]byte(nil), secret...)
	return &CSRF{secret: copied, ttl: ttl, now: now}, nil
}

func (c *CSRF) Issue(subjectID, orgID string, sessionRevision int64) (string, error) {
	payload := csrfPayload{
		Subject: subjectID,
		Org:     orgID,
		Rev:     sessionRevision,
		Expires: c.now().Add(c.ttl).Unix(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal csrf payload: %w", err)
	}
	bodyB64 := base64.RawURLEncoding.EncodeToString(body)
	signed := csrfVersion + "." + bodyB64
	return signed + "." + c.sign(signed), nil
}

func (c *CSRF) Verify(token, subjectID, orgID string, sessionRevision int64) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != csrfVersion {
		return ErrCSRFInvalid
	}
	signed := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(c.sign(signed))) {
		return ErrCSRFInvalid
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ErrCSRFInvalid
	}
	var payload csrfPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return ErrCSRFInvalid
	}
	if payload.Expires <= c.now().Unix() {
		return ErrCSRFInvalid
	}
	if payload.Subject != subjectID || payload.Org != orgID || payload.Rev != sessionRevision {
		return ErrCSRFInvalid
	}
	return nil
}

func (c *CSRF) sign(value string) string {
	mac := hmac.New(sha256.New, c.secret)
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (c *CSRF) SetCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     CSRFCookieName,
		Value:    token,
		Path:     "/work",
		MaxAge:   int(c.ttl.Seconds()),
		Secure:   true,
		HttpOnly: false,
		SameSite: http.SameSiteStrictMode,
	}
}
