# Makefile for {class_name} Test Runner
# Platform: Linux/Windows

# ==========================================
# Configuration
# ==========================================

# Header file and path
HEADER_FILE = {header_file}
HEADER_PATH = $(NUSP_HOME)/src/include  # Linux编译环境路径，禁止使用Windows本地路径

# Dynamic library and path
LIB_NAME = {lib_name}
# 动态库路径（编译路径:发布路径）
LIB_PATH_COMPILE = $(NUSP_HOME)/lib_linux
LIB_PATH_PUBLISH = $(NUSP_HOME)/lib
LIB_EXT = so

# Compiler settings
CXX = g++
CXXFLAGS = -std=c++11 -Wall -I$(HEADER_PATH) -fPIC
LDFLAGS = -L$(LIB_PATH_COMPILE) -L$(LIB_PATH_PUBLISH) -l$(LIB_NAME)

# Test runner
TEST_RUNNER = test_runner
TEST_SRC = test_runner.cpp
CSV_FILE = test_cases.csv

# Output directory
OUTPUT_DIR = .

# ==========================================
# Targets
# ==========================================

.PHONY: all clean run help run_csv

all: $(TEST_RUNNER)

$(TEST_RUNNER): $(TEST_SRC) $(HEADER_PATH)/$(HEADER_FILE)
	@echo "Compiling test runner..."
	$(CXX) $(CXXFLAGS) -o $(TEST_RUNNER) $(TEST_SRC) $(LDFLAGS)
	@echo "Build complete: $(TEST_RUNNER)"

run: $(TEST_RUNNER)
	@echo "Running tests with CSV mode..."
	./$(TEST_RUNNER) $(CSV_FILE)

run_csv: $(TEST_RUNNER)
ifndef CSV
	@echo "Error: CSV variable not set. Usage: make run_csv CSV=test_cases.csv"
	@exit 1
endif
	@echo "Running tests with CSV file: $(CSV)"
	./$(TEST_RUNNER) $(CSV)

clean:
	@echo "Cleaning build artifacts..."
	rm -f $(TEST_RUNNER) test_results.csv
	@echo "Clean complete"

help:
	@echo "{class_name} Test Runner - Makefile"
	@echo "==================================="
	@echo "Targets:"
	@echo "  make           - Compile test runner"
	@echo "  make run       - Run tests with default CSV (test_cases.csv)"
	@echo "  make run_csv CSV=<filename> - Run tests with specified CSV file"
	@echo "  make clean     - Clean build artifacts"
	@echo "  make help      - Show this help"
	@echo ""
	@echo "Environment Variables:"
	@echo "  NUSP_HOME      - Base path for library (default: /opt/nusp)"
	@echo ""
	@echo "Example:"
	@echo "  make run_csv CSV=test_cases.csv"
