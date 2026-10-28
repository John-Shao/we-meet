package apierr

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"sync"

	"github.com/we-meet/work/contracts"
)

type Entry struct {
	Status         int     `json:"status"`
	Retryable      bool    `json:"retryable"`
	RecoveryAction *string `json:"recovery_action"`
	UI             string  `json:"ui"`
}

type Catalog struct {
	Version        string            `json:"version"`
	Public         map[string]Entry  `json:"public"`
	DBExceptionMap map[string]string `json:"db_exception_map"`
	Messages       map[string]string `json:"-"`
}

var defaultCatalog = sync.OnceValue(func() *Catalog {
	catalog, err := Load(contracts.FS)
	if err != nil {
		panic(fmt.Sprintf("invalid embedded error contract: %v", err))
	}
	return catalog
})

func Load(fsys fs.FS) (*Catalog, error) {
	catalog, err := loadCatalog(fsys)
	if err != nil {
		return nil, err
	}
	messages, err := loadMessages(fsys)
	if err != nil {
		return nil, err
	}
	catalog.Messages = messages
	if err := catalog.validate(); err != nil {
		return nil, err
	}
	return catalog, nil
}

func Default() *Catalog {
	return defaultCatalog()
}

func (c *Catalog) Lookup(code string) (Entry, bool) {
	entry, ok := c.Public[code]
	return entry, ok
}

func (c *Catalog) Message(code string) string {
	if message, ok := c.Messages[code]; ok {
		return message
	}
	return c.Messages["service_degraded"]
}

func loadCatalog(fsys fs.FS) (*Catalog, error) {
	body, err := fs.ReadFile(fsys, "error-codes.json")
	if err != nil {
		return nil, fmt.Errorf("read error-codes.json: %w", err)
	}
	var catalog Catalog
	if err := json.Unmarshal(body, &catalog); err != nil {
		return nil, fmt.Errorf("decode error-codes.json: %w", err)
	}
	return &catalog, nil
}

func loadMessages(fsys fs.FS) (map[string]string, error) {
	body, err := fs.ReadFile(fsys, "error-messages.json")
	if err != nil {
		return nil, fmt.Errorf("read error-messages.json: %w", err)
	}
	var messages map[string]string
	if err := json.Unmarshal(body, &messages); err != nil {
		return nil, fmt.Errorf("decode error-messages.json: %w", err)
	}
	return messages, nil
}

func (c *Catalog) validate() error {
	if c.Version == "" {
		return fmt.Errorf("error catalog version is empty")
	}
	if len(c.Public) == 0 {
		return fmt.Errorf("error catalog has no public codes")
	}
	for code, entry := range c.Public {
		if entry.Status < 400 || entry.Status > 599 {
			return fmt.Errorf("public code %q has invalid status %d", code, entry.Status)
		}
		if entry.Retryable && entry.Status != 429 && entry.Status < 500 {
			return fmt.Errorf("public code %q is retryable with status %d", code, entry.Status)
		}
		if _, ok := c.Messages[code]; !ok {
			return fmt.Errorf("public code %q has no safe message", code)
		}
	}
	for raw, code := range c.DBExceptionMap {
		if _, ok := c.Public[code]; !ok {
			return fmt.Errorf("db exception %q maps to non-public code %q", raw, code)
		}
	}
	return nil
}
