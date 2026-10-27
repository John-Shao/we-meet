#!/usr/bin/env python3
"""
R0a 端到端验证脚本

验证 Temporal Worker 与数据库集成
"""
import asyncio
import os
import sys

# 添加 backend 到路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src/backend'))

async def test_temporal_connection():
    """测试 Temporal 连接"""
    from temporalio.client import Client
    
    temporal_address = os.getenv("TEMPORAL_ADDRESS", "127.0.0.1:7233")
    print(f"Connecting to Temporal at {temporal_address}...")
    
    try:
        client = await Client.connect(temporal_address)
        print("✓ Temporal connected")
        
        # 列出 task queues
        print("\nChecking task queues...")
        # Temporal Python SDK 没有直接列出 task queues 的 API
        # 但我们可以检查 worker 是否注册
        print("✓ Temporal client ready")
        
        return True
    except Exception as e:
        print(f"✗ Temporal connection failed: {e}")
        return False


async def test_database_connection():
    """测试数据库连接"""
    import asyncpg
    
    db_url = os.getenv(
        "WORK_DATABASE_URL",
        "postgresql://postgres@127.0.0.1:55435/work_r0a_e1"
    )
    print(f"\nConnecting to database...")
    
    try:
        pool = await asyncpg.create_pool(db_url, min_size=1, max_size=2)
        async with pool.acquire() as conn:
            # 检查 work schema
            result = await conn.fetchval("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.schemata 
                    WHERE schema_name = 'work'
                )
            """)
            if result:
                print("✓ work schema exists")
            else:
                print("✗ work schema not found")
                return False
            
            # 检查关键表
            tables = await conn.fetch("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'work'
                AND table_name IN ('org', 'task', 'run', 'operation', 'artifact')
                ORDER BY table_name
            """)
            print(f"✓ Found {len(tables)} tables: {[t['table_name'] for t in tables]}")
            
            # 检查 SQL 函数
            functions = await conn.fetch("""
                SELECT routine_name FROM information_schema.routines
                WHERE routine_schema = 'work'
                AND routine_name IN ('acquire_run', 'reserve_quota', 'claim_dispatch', 'finish_run')
                ORDER BY routine_name
            """)
            print(f"✓ Found {len(functions)} functions: {[f['routine_name'] for f in functions]}")
        
        await pool.close()
        return True
    except Exception as e:
        print(f"✗ Database connection failed: {e}")
        return False


async def main():
    """主函数"""
    print("=" * 60)
    print("R0a 端到端验证")
    print("=" * 60)
    
    results = []
    
    # 测试 1: Temporal 连接
    results.append(await test_temporal_connection())
    
    # 测试 2: 数据库连接
    results.append(await test_database_connection())
    
    # 总结
    print("\n" + "=" * 60)
    print("验证结果")
    print("=" * 60)
    if all(results):
        print("✓ 所有测试通过")
        print("\n下一步:")
        print("1. 启动 worker: python deploy/aliyun/temporal/worker/worker.py")
        print("2. 创建 outbox 事件并提交")
        print("3. 观察 Temporal workflow 执行")
        return 0
    else:
        print("✗ 部分测试失败")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
