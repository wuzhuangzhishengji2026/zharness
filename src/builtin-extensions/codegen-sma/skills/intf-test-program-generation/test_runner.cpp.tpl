/*
 * CParaManage Interface Test Runner
 * Auto-generated test program for CParaManage class
 */

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <cstring>
#include <cstdlib>
#include <ctime>
#include "{header_file}"

using namespace std;

// Global object pointer
static CParaManage* g_pParaManage = NULL;
static string g_log_file = "test_runner.log";
static ofstream g_log_stream;
static bool g_skip_cleanup = false;  // Skip post_cleanup for pre_setup operations

// Test case structure
struct TestCase {{
    string case_id;
    string interface_name;
    string case_name;
    string section;
    string key;
    string value_type;
    string value;
    int bufsize;
    int key_count;
    int expected_ret;
    string expected_value;
    string description;
    string pre_setup;
    string post_cleanup;
    string para_file_name;
}};

// Log function
void log(const string& msg) {{
    cout << msg << endl;
    cout.flush();
    if (g_log_stream.is_open()) {{
        g_log_stream << msg << endl;
        g_log_stream.flush();
    }}
}}

// Split string by delimiter
vector<string> split(const string& str, char delimiter) {{
    vector<string> tokens;
    string token;
    istringstream tokenStream(str);
    while (getline(tokenStream, token, delimiter)) {{
        tokens.push_back(token);
    }}
    return tokens;
}}

// Execute a single operation with unified logging
// phase: PRE_SETUP | MAIN_CMD | POST_CLEANUP
int executeOperation(const string& phase, const string& cmd, const vector<string>& parts) {{
    string prefix = "  [" + phase + "] ";
    
    if (g_pParaManage == NULL) {{
        log(prefix + "ERROR: CParaManage object is NULL");
        return -1;
    }}
    
    if (cmd == "SetKey" && parts.size() >= 5) {{
        string section = parts[1];
        string key = parts[2];
        string value_type = parts[3];
        string value = parts[4];
        
        log(prefix + "SetKey: section=[" + section + "], key=[" + key + "], type=[" + value_type + "], value=[" + value + "]");
        
        int ret = -1;
        if (value_type == "string") {{
            log(prefix + "Calling SetKey(string, string, string)");
            ret = g_pParaManage->SetKey((char*)section.c_str(), (char*)key.c_str(), (char*)value.c_str());
        }} else if (value_type == "int") {{
            log(prefix + "Calling SetKey(string, string, int)");
            ret = g_pParaManage->SetKey((char*)section.c_str(), (char*)key.c_str(), atoi(value.c_str()));
        }} else if (value_type == "double") {{
            log(prefix + "Calling SetKey(string, string, double)");
            ret = g_pParaManage->SetKey((char*)section.c_str(), (char*)key.c_str(), atof(value.c_str()));
        }} else {{
            log(prefix + "Unknown value_type: " + value_type);
        }}
        log(prefix + "SetKey returned: " + to_string(ret));
        return ret;
        
    }} else if (cmd == "DelKey" && parts.size() >= 3) {{
        string section = parts[1];
        string key = parts[2];
        log(prefix + "DelKey: section=[" + section + "], key=[" + key + "]");
        int ret = g_pParaManage->DelKey((char*)section.c_str(), (char*)key.c_str());
        log(prefix + "DelKey returned: " + to_string(ret));
        return ret;
        
    }} else if (cmd == "DelSection" && parts.size() >= 2) {{
        string section = parts[1];
        log(prefix + "DelSection: section=[" + section + "]");
        int ret = g_pParaManage->DelSection((char*)section.c_str());
        log(prefix + "DelSection returned: " + to_string(ret));
        return ret;
        
    }} else if (cmd == "SetKeys" && parts.size() >= 3) {{
        // SetKeys:section:key1=val1,key2=val2,key3=val3
        string section = parts[1];
        string kv_pairs = parts[2];
        log(prefix + "SetKeys: section=[" + section + "], kv_pairs=[" + kv_pairs + "]");
        
        vector<string> kvs = split(kv_pairs, ',');
        log(prefix + "Parsed " + to_string(kvs.size()) + " key-value pairs");
        
        for (size_t j = 0; j < kvs.size(); ++j) {{
            vector<string> kv = split(kvs[j], '=');
            if (kv.size() >= 2) {{
                log(prefix + "SetKey: section=" + section + ", key=" + kv[0] + ", value=" + kv[1]);
                int ret = g_pParaManage->SetKey((char*)section.c_str(), (char*)kv[0].c_str(), (char*)kv[1].c_str());
                log(prefix + "SetKey returned: " + to_string(ret));
            }}
        }}
        return 1;
        
    }} else if (cmd == "SetKeys" && parts.size() >= 2) {{
        // SetKeys:section:key_count:N (for array-based SetKeys)
        string section = parts[1];
        int key_count = 1;
        if (parts.size() >= 3) {{
            key_count = atoi(parts[2].c_str());
        }}
        log(prefix + "SetKeys (array): section=[" + section + "], key_count=" + to_string(key_count));
        
        if (key_count > 0) {{
            CParaManage::PARA_KEY_VALUE* keys = new CParaManage::PARA_KEY_VALUE[key_count];
            for (int k = 0; k < key_count; k++) {{
                snprintf(keys[k].para_key, sizeof(keys[k].para_key), "key%d", k);
                snprintf(keys[k].para_val, sizeof(keys[k].para_val), "value%d", k);
                log(prefix + "  key[" + to_string(k) + "]: " + keys[k].para_key + "=" + keys[k].para_val);
            }}
            int ret = g_pParaManage->SetKeys((char*)section.c_str(), keys, key_count);
            log(prefix + "SetKeys returned: " + to_string(ret));
            delete[] keys;
            return ret;
        }}
        return -1;
        
    }} else {{
        log(prefix + "Unknown command: " + cmd + ", parts count: " + to_string(parts.size()));
        return -1;
    }}
}}

// Execute operation list (pipe-separated)
// ops_str format: "SetKey:...|DelKey:...|DelSection:..."
void executeOperationList(const string& phase, const string& ops_str) {{
    string prefix = "  [" + phase + "] ";
    
    if (ops_str.empty()) {{
        log(prefix + "No operations defined");
        return;
    }}
    
    if (g_pParaManage == NULL) {{
        log(prefix + "ERROR: CParaManage object is NULL, cannot execute operations");
        return;
    }}
    
    log(prefix + "Operations: [" + ops_str + "]");
    
    vector<string> ops = split(ops_str, '|');
    for (size_t i = 0; i < ops.size(); ++i) {{
        string op = ops[i];
        if (op.empty()) continue;
        
        vector<string> parts = split(op, ':');
        if (parts.empty()) continue;
        
        string cmd = parts[0];
        log(prefix + "Executing: " + cmd);
        executeOperation(phase, cmd, parts);
    }}
}}

// Execute pre_setup operations (wrapper)
void executePreSetup(const string& pre_setup, const string& ini_file) {{
    if (!ini_file.empty()) {{
        log("  [PRE_SETUP] ini_file=[" + ini_file + "]");
    }}
    executeOperationList("PRE_SETUP", pre_setup);
}}

// Execute post_cleanup operations (wrapper)
void executePostCleanup(const string& post_cleanup) {{
    executeOperationList("POST_CLEANUP", post_cleanup);
}}

// Create test object with specified INI file
bool createTestObject(const string& ini_file) {{
    log("  [CreateObject] Attempting to create CParaManage object");
    log("  [CreateObject] ini_file parameter: [" + ini_file + "]");
    
    g_pParaManage = CParaManage::CreateObject((char*)ini_file.c_str());
    
    if (!g_pParaManage) {{
        log("  [CreateObject] FAILED: CreateObject returned NULL");
        return false;
    }}
    
    log("  [CreateObject] SUCCESS: CParaManage object created");
    return true;
}}

// Remove test object
void removeTestObject() {{
    if (g_pParaManage) {{
        CParaManage::RemoveObject(g_pParaManage);
        g_pParaManage = NULL;
    }}
}}

// Run post_cleanup case (separate process)
int runPostCleanupCase(const TestCase& tc) {{
    // Determine INI file name
    string ini_file;
    if (!tc.para_file_name.empty()) {{
        ini_file = tc.para_file_name;
        log("  [INI] Using para_file_name: [" + ini_file + "]");
    }} else if (!tc.section.empty() && tc.section != "NULL" && tc.section != "") {{
        ini_file = "test_" + tc.section + ".ini";
        log("  [INI] Generated from section: [" + ini_file + "]");
    }} else {{
        ini_file = "test.ini";
        log("  [INI] Using default: [" + ini_file + "]");
    }}

    // Create object
    if (!createTestObject(ini_file)) {{
        return -1;
    }}

    // Execute post_cleanup defined in YAML
    if (!tc.post_cleanup.empty()) {{
        log("  [POST_CLEANUP] Defined: [" + tc.post_cleanup + "]");
        executeOperationList("POST_CLEANUP", tc.post_cleanup);
    }}

    // Always cleanup current test section (auto cleanup)
    if (!tc.section.empty() && tc.section != "NULL" && tc.section != "") {{
        log("  [POST_CLEANUP] Auto cleanup section: [" + tc.section + "]");
        vector<string> parts = {{"DelSection", tc.section}};
        executeOperation("POST_CLEANUP", "DelSection", parts);
    }}

    // Remove object
    removeTestObject();

    return 1;
}}

// Run a single test case
int runTestCase(const TestCase& tc) {{
    // Determine INI file name
    string ini_file;
    if (!tc.para_file_name.empty()) {{
        ini_file = tc.para_file_name;
        log("  [INI] Using para_file_name: [" + ini_file + "]");
    }} else if (!tc.section.empty() && tc.section != "NULL" && tc.section != "") {{
        ini_file = "test_" + tc.section + ".ini";
        log("  [INI] Generated from section: [" + ini_file + "]");
    }} else {{
        ini_file = "test.ini";
        log("  [INI] Using default: [" + ini_file + "]");
    }}
    
    // Print pre_setup info before creating object
    if (!tc.pre_setup.empty()) {{
        log("  [PRE_SETUP] Defined: [" + tc.pre_setup + "]");
    }} else {{
        log("  [PRE_SETUP] None defined");
    }}
    
    // Create object
    if (!createTestObject(ini_file)) {{
        return -1;
    }}
    
    // Execute pre_setup
    if (!tc.pre_setup.empty()) {{
        log("  [PRE_SETUP] Starting execution...");
        executePreSetup(tc.pre_setup, ini_file);
        log("  [PRE_SETUP] Execution complete");
    }}
    
    int actual_ret = -1;
    
    // Execute main test
    if (tc.interface_name == "SetKey") {{
        if (tc.value_type == "string") {{
            actual_ret = g_pParaManage->SetKey((char*)tc.section.c_str(), (char*)tc.key.c_str(), (char*)tc.value.c_str());
        }} else if (tc.value_type == "int") {{
            actual_ret = g_pParaManage->SetKey((char*)tc.section.c_str(), (char*)tc.key.c_str(), atoi(tc.value.c_str()));
        }} else if (tc.value_type == "double") {{
            actual_ret = g_pParaManage->SetKey((char*)tc.section.c_str(), (char*)tc.key.c_str(), atof(tc.value.c_str()));
        }}
    }} else if (tc.interface_name == "GetKey") {{
        if (tc.value_type == "string") {{
            char buf[4096] = {{0}};
            actual_ret = g_pParaManage->GetKey((char*)tc.section.c_str(), (char*)tc.key.c_str(), buf, tc.bufsize);
        }} else if (tc.value_type == "int") {{
            int val = 0;
            actual_ret = g_pParaManage->GetKey((char*)tc.section.c_str(), (char*)tc.key.c_str(), val);
        }} else if (tc.value_type == "double") {{
            double val = 0.0;
            actual_ret = g_pParaManage->GetKey((char*)tc.section.c_str(), (char*)tc.key.c_str(), val);
        }}
    }} else if (tc.interface_name == "DelKey") {{
        actual_ret = g_pParaManage->DelKey((char*)tc.section.c_str(), (char*)tc.key.c_str());
    }} else if (tc.interface_name == "DelSection") {{
        actual_ret = g_pParaManage->DelSection((char*)tc.section.c_str());
    }} else if (tc.interface_name == "GetKeyNum") {{
        int key_num = 0;
        actual_ret = g_pParaManage->GetKeyNum((char*)tc.section.c_str(), key_num);
    }} else if (tc.interface_name == "SetKeys") {{
        if (tc.key_count > 0) {{
            CParaManage::PARA_KEY_VALUE* keys = new CParaManage::PARA_KEY_VALUE[tc.key_count];
            for (int i = 0; i < tc.key_count; i++) {{
                snprintf(keys[i].para_key, sizeof(keys[i].para_key), "key%d", i);
                snprintf(keys[i].para_val, sizeof(keys[i].para_val), "value%d", i);
            }}
            actual_ret = g_pParaManage->SetKeys((char*)tc.section.c_str(), keys, tc.key_count);
            delete[] keys;
        }}
    }} else if (tc.interface_name == "GetKeys") {{
        if (tc.key_count > 0) {{
            CParaManage::PARA_KEY_VALUE* keys = new CParaManage::PARA_KEY_VALUE[tc.key_count];
            actual_ret = g_pParaManage->GetKeys((char*)tc.section.c_str(), keys, tc.key_count);
            delete[] keys;
        }}
    }} else if (tc.interface_name == "CreateObject") {{
        // CreateObject is already called, just return success
        actual_ret = 1;
    }}
    
    // Execute post_cleanup (skip if --skip-cleanup is set)
    if (!g_skip_cleanup) {{
        cleanupTestData(tc);
    }} else {{
        log("  [CLEANUP] Skipped (skip-cleanup mode)");
    }}
    
    // Remove object
    removeTestObject();
    
    return actual_ret;
}}

// Check test result
bool checkResult(int actual_ret, int expected_ret) {{
    if (expected_ret > 0) {{
        return actual_ret >= expected_ret;
    }} else if (expected_ret < 0) {{
        return actual_ret < 0;
    }} else {{
        return actual_ret == expected_ret;
    }}
}}

// Print test case result
void printTestCase(const TestCase& tc, int actual_ret, bool passed) {{
    log("========================================");
    log("Case: " + tc.case_id + " - " + tc.case_name);
    log("Interface: " + tc.interface_name);
    log("Input Parameters:");
    log("  section = " + tc.section);
    log("  key = " + tc.key);
    log("  value_type = " + tc.value_type);
    log("  value = " + tc.value);
    log("  bufsize = " + to_string(tc.bufsize));
    log("  key_count = " + to_string(tc.key_count));
    log("  para_file_name = " + tc.para_file_name);
    log("Expected Return: " + to_string(tc.expected_ret));
    log("Actual Return: " + to_string(actual_ret));
    log("Result: [" + string(passed ? "PASS" : "FAIL") + "]");
    log("========================================");
}}

// Print usage
void printUsage(const char* prog) {{
    cout << "CParaManage Interface Test Runner" << endl;
    cout << "========================================" << endl;
    cout << "Usage:" << endl;
    cout << "  " << prog << " --interface <name> [options] <expected_ret>" << endl;
    cout << endl;
    cout << "Required:" << endl;
    cout << "  --interface <name>    Interface name (SetKey, GetKey, DelKey, DelSection, GetKeyNum, SetKeys, GetKeys, CreateObject)" << endl;
    cout << "  <expected_ret>         Expected return value (last parameter)" << endl;
    cout << endl;
    cout << "Optional:" << endl;
    cout << "  --section <sec>        Section name" << endl;
    cout << "  --key <key>            Key name" << endl;
    cout << "  --value <val>          Value to set" << endl;
    cout << "  --value-type <type>    Value type (string, int, double)" << endl;
    cout << "  --bufsize <size>       Buffer size for string get" << endl;
    cout << "  --key-count <count>    Number of keys for batch operations" << endl;
    cout << "  --para-file-name <fn>  INI file name" << endl;
    cout << "  --case-id <id>         Test case ID" << endl;
    cout << "  --skip-cleanup          Skip post_cleanup (for pre_setup operations)" << endl;
    cout << "  --log-file <file>      Log file path" << endl;
    cout << "  --help                 Show this help" << endl;
    cout << endl;
    cout << "Examples:" << endl;
    cout << "  " << prog << " --interface SetKey --section TEST --key k1 --value v1 --value-type string 1" << endl;
    cout << "  " << prog << " --interface GetKey --section TEST --key k1 --value-type string --bufsize 64 1" << endl;
    cout << "  " << prog << " --interface DelKey --section TEST --key k1 1" << endl;
}}

// Main function
int main(int argc, char* argv[]) {{
    // Open log file
    g_log_stream.open(g_log_file.c_str(), ios::app);
    if (g_log_stream.is_open()) {{
        time_t now = time(NULL);
        char timestamp[64];
        strftime(timestamp, sizeof(timestamp), "%Y-%m-%d %H:%M:%S", localtime(&now));
        g_log_stream << "\n=== Test Run Started at " << timestamp << " ===" << endl;
    }}
    
    log("CParaManage Interface Test Runner");
    log("========================================");
    
    if (argc < 2) {{
        printUsage(argv[0]);
        if (g_log_stream.is_open()) g_log_stream.close();
        return 1;
    }}
    
    // Parse command line arguments
    TestCase tc;
    tc.bufsize = 0;
    tc.key_count = 0;
    tc.expected_ret = 0;
    
    for (int i = 1; i < argc; ++i) {{
        string arg = argv[i];
        
        if (arg == "--help" || arg == "-h") {{
            printUsage(argv[0]);
            if (g_log_stream.is_open()) g_log_stream.close();
            return 0;
        }}
        else if (arg == "--interface" && i + 1 < argc) {{
            tc.interface_name = argv[++i];
        }}
        else if (arg == "--section" && i + 1 < argc) {{
            tc.section = argv[++i];
        }}
        else if (arg == "--key" && i + 1 < argc) {{
            tc.key = argv[++i];
        }}
        else if (arg == "--value" && i + 1 < argc) {{
            tc.value = argv[++i];
        }}
        else if (arg == "--value-type" && i + 1 < argc) {{
            tc.value_type = argv[++i];
        }}
        else if (arg == "--bufsize" && i + 1 < argc) {{
            tc.bufsize = atoi(argv[++i]);
        }}
        else if (arg == "--key-count" && i + 1 < argc) {{
            tc.key_count = atoi(argv[++i]);
        }}
        else if (arg == "--para-file-name" && i + 1 < argc) {{
            tc.para_file_name = argv[++i];
        }}
        else if (arg == "--case-id" && i + 1 < argc) {{
            tc.case_id = argv[++i];
        }}
        else if (arg == "--log-file" && i + 1 < argc) {{
            g_log_file = argv[++i];
            g_log_stream.close();
            g_log_stream.open(g_log_file.c_str(), ios::app);
        }}
        else if (arg == "--skip-cleanup") {{
            g_skip_cleanup = true;
            log("  [MODE] Skip cleanup enabled (for pre_setup operations)");
        }}
        else if (arg == "--post-cleanup") {{
            // Execute post_cleanup mode (separate process)
            log("  [MODE] Post cleanup mode");

            // Set default values
            if (tc.case_id.empty()) {{
                tc.case_id = "POST_CLEANUP";
            }}
            if (tc.case_name.empty()) {{
                tc.case_name = "Post Cleanup Test";
            }}

            // Run post_cleanup
            int cleanup_ret = runPostCleanupCase(tc);

            printTestCase(tc, cleanup_ret, true);

            if (g_log_stream.is_open()) {{
                g_log_stream << "=== Post Cleanup Finished ===" << endl;
                g_log_stream.close();
            }}

            return cleanup_ret >= 0 ? 0 : 1;
        }}
        else if (arg == "--expected-ret" && i + 1 < argc) {{
            tc.expected_ret = atoi(argv[++i]);
        }}
    }}
    
    // Parse expected_ret from last argument if not set by --expected-ret
    if (tc.expected_ret == 0 && argc > 1) {{
        string last_arg = argv[argc - 1];
        if (last_arg.find("--") == string::npos) {{
            tc.expected_ret = atoi(last_arg.c_str());
        }}
    }}
    
    // Set default values
    if (tc.case_id.empty()) {{
        tc.case_id = "CMD_TEST";
    }}
    if (tc.case_name.empty()) {{
        tc.case_name = "Command Line Test";
    }}
    
    // Run test
    int actual_ret = runTestCase(tc);
    bool passed = checkResult(actual_ret, tc.expected_ret);
    
    printTestCase(tc, actual_ret, passed);
    
    if (g_log_stream.is_open()) {{
        g_log_stream << "=== Test Run Finished ===" << endl;
        g_log_stream.close();
    }}
    
    return passed ? 0 : 1;
}}
