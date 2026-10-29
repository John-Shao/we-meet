package api_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

func TestTaskEventsStreamsNewEventsAndReplaysCursor(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "events-input-0001", "事件流目标", "")
	submittedID, submittedType := taskEventRow(t, dbName, created.TaskID, 1)
	if submittedType != "task.submitted" || submittedID == "" {
		t.Fatalf("submitted event = %q/%q", submittedID, submittedType)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream := openEventStream(t, ctx, server.URL, created.TaskID, "")
	if stream.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d body=%s", stream.StatusCode, readBody(stream))
	}
	if contentType := stream.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("content type = %q", contentType)
	}
	reader := bufio.NewReader(stream.Body)
	response := taskRequest(t, http.MethodPatch,
		server.URL+"/work/v1/tasks/"+created.TaskID, token,
		`{"client_request_id":"events-title-0001","expected_revision":1,"title":"事件流标题"}`)
	response.Body.Close()
	event := readSSEEvent(t, reader)
	stream.Body.Close()
	updatedID, updatedType := taskEventRow(t, dbName, created.TaskID, 2)
	if updatedType != "task.updated" || updatedID == "" {
		t.Fatalf("updated event = %q/%q", updatedID, updatedType)
	}
	if event.ID != updatedID || event.Event != "task.updated" || event.Data.EventID != updatedID ||
		event.Data.Seq != 2 || event.Data.Type != "task.updated" ||
		event.Data.SchemaVersion != "work-event-v1" || event.Data.TaskID != created.TaskID {
		t.Fatalf("event = %#v", event)
	}

	replayCtx, replayCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer replayCancel()
	replay := openEventStream(t, replayCtx, server.URL, created.TaskID, submittedID)
	defer replay.Body.Close()
	if replay.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	replayed := readSSEEvent(t, bufio.NewReader(replay.Body))
	if replayed.ID != updatedID || replayed.Event != "task.updated" {
		t.Fatalf("replayed = %#v", replayed)
	}

	resyncRequest, err := http.NewRequest(http.MethodGet,
		server.URL+"/work/v1/tasks/"+created.TaskID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resyncRequest.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	resyncRequest.Header.Set("Last-Event-ID", "99999999-9999-4999-8999-999999999999")
	resyncRequest.Header.Set("Accept", "text/event-stream")
	resyncResponse, err := http.DefaultClient.Do(resyncRequest)
	if err != nil {
		t.Fatal(err)
	}
	if resyncResponse.StatusCode != http.StatusConflict ||
		resyncResponse.Header.Get("X-Work-Event-Cursor") != updatedID {
		t.Fatalf("resync status=%d cursor=%q", resyncResponse.StatusCode, resyncResponse.Header.Get("X-Work-Event-Cursor"))
	}
	assertAPICode(t, resyncResponse, http.StatusConflict, "resync_required")

	hidden := openEventStream(t, mustContext(t), server.URL, taskC, "")
	assertAPICode(t, hidden, http.StatusNotFound, "task_not_found")

	unauthorized, err := http.NewRequest(http.MethodGet,
		server.URL+"/work/v1/tasks/"+created.TaskID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	unauthorizedResponse, err := http.DefaultClient.Do(unauthorized)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, unauthorizedResponse, http.StatusUnauthorized, "unauthorized")
}

func TestTaskEventsSurviveServerWriteTimeout(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	contentStore := newTestContentStore(t)
	server, err := api.NewServerWithContent(pool, &stubVerifier{claims: testClaims()},
		testCSRF(t), contentStore, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewUnstartedServer(server.Handler())
	httpServer.Config.WriteTimeout = 400 * time.Millisecond
	httpServer.Start()
	t.Cleanup(httpServer.Close)
	token := bootstrapCSRF(t, httpServer.URL)
	created := createTaskForTest(t, httpServer.URL, token, "events-timeout-0001", "长连接目标", "")

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	stream := openEventStream(t, ctx, httpServer.URL, created.TaskID, "")
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	time.Sleep(1200 * time.Millisecond)
	response := taskRequest(t, http.MethodPatch,
		httpServer.URL+"/work/v1/tasks/"+created.TaskID, token,
		`{"client_request_id":"events-timeout-0002","expected_revision":1,"title":"超时后标题"}`)
	response.Body.Close()
	event := readSSEEvent(t, reader)
	if event.Event != "task.updated" || event.Data.Seq != 2 {
		t.Fatalf("event = %#v", event)
	}
}

type sseEvent struct {
	ID    string
	Event string
	Data  api.TaskEvent
}

func openEventStream(t *testing.T, ctx context.Context, baseURL, taskID, lastEventID string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		baseURL+"/work/v1/tasks/"+taskID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	request.Header.Set("Accept", "text/event-stream")
	if lastEventID != "" {
		request.Header.Set("Last-Event-ID", lastEventID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func readSSEEvent(t *testing.T, reader *bufio.Reader) sseEvent {
	t.Helper()
	var event sseEvent
	var data strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE event: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if data.Len() == 0 {
				continue
			}
			if err := json.Unmarshal([]byte(data.String()), &event.Data); err != nil {
				t.Fatalf("decode SSE data: %v", err)
			}
			return event
		}
		if strings.HasPrefix(line, ":") || strings.HasPrefix(line, "retry:") {
			continue
		}
		field, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "id":
			event.ID = value
		case "event":
			event.Event = value
		case "data":
			data.WriteString(value)
		}
	}
}

func taskEventRow(t *testing.T, dbName, taskID string, seq int64) (string, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var id, eventType string
	if err := conn.QueryRow(ctx, `
		SELECT id, type FROM work.task_event
		WHERE task_id = $1 AND seq = $2`, taskID, seq,
	).Scan(&id, &eventType); err != nil {
		t.Fatal(err)
	}
	return id, eventType
}

func mustContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}
