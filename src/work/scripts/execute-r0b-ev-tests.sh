#!/bin/bash
# R0b EV Test Execution Script
# Purpose: Set up PostgreSQL environment and execute all TestR0b* tests
# Date: 2026-11-10

set -e  # Exit on error

echo "=========================================="
echo "R0b EV Test Execution"
echo "=========================================="
echo ""

# Configuration
PG_USER="work"
PG_PASSWORD="work"
PG_DB="work_test"
PG_PORT="5432"
CONTAINER_NAME="work-test-pg"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed or not in PATH"
    print_info "Please install Docker Desktop or use an alternative PostgreSQL setup"
    exit 1
fi

# Stop and remove existing container if it exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_warn "Removing existing container ${CONTAINER_NAME}..."
    docker stop ${CONTAINER_NAME} 2>/dev/null || true
    docker rm ${CONTAINER_NAME} 2>/dev/null || true
fi

# Start PostgreSQL container
print_info "Starting PostgreSQL 16 container..."
docker run -d \
    --name ${CONTAINER_NAME} \
    -e POSTGRES_USER=${PG_USER} \
    -e POSTGRES_PASSWORD=${PG_PASSWORD} \
    -e POSTGRES_DB=${PG_DB} \
    -p ${PG_PORT}:5432 \
    postgres:16 \
    > /dev/null

if [ $? -ne 0 ]; then
    print_error "Failed to start PostgreSQL container"
    exit 1
fi

print_info "PostgreSQL container started"

# Wait for PostgreSQL to be ready
print_info "Waiting for PostgreSQL to be ready..."
sleep 5

# Verify connection
print_info "Verifying PostgreSQL connection..."
if ! docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${PG_DB} -c "SELECT 1" > /dev/null 2>&1; then
    print_error "Failed to connect to PostgreSQL"
    docker logs ${CONTAINER_NAME}
    exit 1
fi

print_info "PostgreSQL is ready"

# Set environment variable for Go tests
export WORK_TEST_PG_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}?sslmode=disable"
print_info "Set WORK_TEST_PG_URL=${WORK_TEST_PG_URL}"

# Navigate to work directory
cd "$(dirname "$0")/.."
print_info "Working directory: $(pwd)"

# Run code quality checks first
print_info "Running code quality checks..."
echo ""

print_info "1. Go build..."
if go build ./internal/migrate/... 2>&1; then
    print_info "   ✓ Build passed"
else
    print_error "   ✗ Build failed"
    exit 1
fi

print_info "2. Go vet..."
if go vet ./internal/migrate/... 2>&1; then
    print_info "   ✓ Vet passed"
else
    print_error "   ✗ Vet failed"
    exit 1
fi

print_info "3. Go fmt..."
UNFORMATTED=$(gofmt -l ./internal/migrate/r0b_*.go 2>&1)
if [ -z "$UNFORMATTED" ]; then
    print_info "   ✓ Format check passed"
else
    print_error "   ✗ Files need formatting:"
    echo "$UNFORMATTED"
    exit 1
fi

echo ""
print_info "All code quality checks passed!"
echo ""

# List all TestR0b* tests
print_info "Listing all TestR0b* tests..."
TEST_COUNT=$(go test ./internal/migrate -run "TestR0b" -list ".*" 2>&1 | grep -E "^TestR0b" | wc -l)
print_info "Found ${TEST_COUNT} TestR0b* functions"
echo ""

# Execute tests
print_info "Executing TestR0b* tests..."
print_info "This may take several minutes..."
echo ""

# Create results file
RESULTS_FILE="ev-test-results-$(date +%Y%m%d-%H%M%S).log"
print_info "Results will be saved to: ${RESULTS_FILE}"
echo ""

# Run tests with verbose output
if go test ./internal/migrate -run "TestR0b" -v 2>&1 | tee "${RESULTS_FILE}"; then
    print_info "Tests completed successfully"
else
    print_error "Tests failed"
fi

echo ""
print_info "==========================================" 
print_info "Test Execution Summary"
print_info "==========================================" 
echo ""

# Parse results
if [ -f "${RESULTS_FILE}" ]; then
    PASS_COUNT=$(grep -E "^--- PASS:" "${RESULTS_FILE}" | wc -l)
    FAIL_COUNT=$(grep -E "^--- FAIL:" "${RESULTS_FILE}" | wc -l)
    SKIP_COUNT=$(grep -E "^--- SKIP:" "${RESULTS_FILE}" | wc -l)
    
    print_info "PASS: ${PASS_COUNT}"
    print_info "FAIL: ${FAIL_COUNT}"
    print_info "SKIP: ${SKIP_COUNT}"
    echo ""
    
    if [ ${FAIL_COUNT} -gt 0 ]; then
        print_error "Some tests failed. Check ${RESULTS_FILE} for details."
        echo ""
        print_info "Failed tests:"
        grep -E "^--- FAIL:" "${RESULTS_FILE}" | sed 's/^/  /'
    elif [ ${SKIP_COUNT} -gt 0 ]; then
        print_warn "Some tests were skipped. Check ${RESULTS_FILE} for details."
    else
        print_info "All tests passed!"
    fi
else
    print_error "Results file not found"
fi

echo ""
print_info "==========================================" 
print_info "Next Steps"
print_info "==========================================" 
echo ""
print_info "1. Review test results in: ${RESULTS_FILE}"
print_info "2. Analyze any failures and fix issues"
print_info "3. Prepare C26 review materials with this evidence"
print_info "4. To stop PostgreSQL container:"
print_info "   docker stop ${CONTAINER_NAME}"
print_info "5. To remove PostgreSQL container:"
print_info "   docker rm ${CONTAINER_NAME}"
echo ""

# Keep container running for manual inspection
print_info "PostgreSQL container is still running for manual inspection"
print_info "Connection string: ${WORK_TEST_PG_URL}"
echo ""
