# {class_name} 接口测试用例

## 文件结构

```
{output_dir}/
├── test_cases.csv      # 测试用例数据（CSV格式）
├── test_runner.cpp     # C++ 测试执行程序
├── Makefile            # 编译构建文件
├── test_results.csv    # 测试结果报告（运行时生成）
└── README.md           # 本文件
```

## 测试用例格式 (CSV)

| 字段 | 说明 |
|------|------|
| case_id | 用例唯一标识 |
| interface | 接口名称 |
| case_name | 用例名称 |
| section | 配置文件节名 |
| key | 键名 |
| value_type | 值类型（string/int/double） |
| value | 输入值 |
| bufsize | 缓冲区大小 |
| key_count | 批量操作数量 |
| expected_ret | 期望返回值 |
| expected_value | 期望返回值内容 |
| description | 用例描述 |

## 编译与运行

### 编译测试程序

```bash
make
```

### 运行测试（CSV模式）

```bash
make run
```

或指定CSV文件：

```bash
make run_csv CSV=test_cases.csv
```

### 命令行模式

```bash
# 预期返回值放最后
./test_runner --interface SetKey --section NODE_NAME --key test1 --value hello --value-type string 1
./test_runner --interface GetKey --section NODE_NAME --key test1 --value-type string --bufsize 128 1
```

### 清理

```bash
make clean
```

## 环境配置

测试程序依赖以下环境变量：
- `NUSP_HOME`: 库基础路径（默认: /opt/nusp）

确保动态库路径配置正确：
- 头文件路径: `$NUSP_HOME/src/include`
- 动态库路径: `$NUSP_HOME/lib`

## 测试覆盖的接口

{interfaces_list}

## 测试结果

测试完成后，结果保存在 `test_results.csv` 文件中，包含：
- case_id: 用例ID
- interface: 接口名称
- expected_ret: 期望返回值
- actual_ret: 实际返回值
- result: PASS/FAIL
- description: 用例描述
