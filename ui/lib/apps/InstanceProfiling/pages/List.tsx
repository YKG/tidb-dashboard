import { Badge, Button, Form, message, Select, TreeSelect } from 'antd'
import { ScrollablePane } from 'office-ui-fabric-react/lib/ScrollablePane'
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { usePersistFn } from '@umijs/hooks'

import client from '@lib/client'
import { Card, CardTableV2 } from '@lib/components'
import DateTime from '@lib/components/DateTime'
import openLink from '@lib/utils/openLink'
import { useClientRequest } from '@lib/utils/useClientRequest'

// FIXME: The following logic should be extracted into a common component.
function getTreeData(topologyMap) {
  const treeDataByKind = {
    tidb: [],
    tikv: [],
    pd: [],
  }
  Object.values(topologyMap).forEach((target: any) => {
    if (!(target.kind in treeDataByKind)) {
      return
    }
    treeDataByKind[target.kind].push({
      title: target.display_name,
      value: target.display_name,
      key: target.display_name,
    })
  })
  const kindTitleMap = {
    tidb: 'TiDB',
    tikv: 'TiKV',
    pd: 'PD',
  }
  return Object.keys(treeDataByKind)
    .filter((kind) => treeDataByKind[kind].length > 0)
    .map((kind) => ({
      title: kindTitleMap[kind],
      value: kind,
      key: kind,
      children: treeDataByKind[kind],
    }))
}

function filterTreeNode(inputValue, treeNode) {
  const name = treeNode.key
  return name.includes(inputValue)
}

function useTargetsMap() {
  const { data } = useClientRequest((cancelToken) =>
    client.getInstance().topologyAllGet({ cancelToken })
  )
  return useMemo(() => {
    const map = {}
    if (!data) {
      return map
    }
    // FIXME, declare type
    data.tidb?.nodes?.forEach((node) => {
      const display = `${node.ip}:${node.port}`
      const target = {
        kind: 'tidb',
        display_name: display,
        ip: node.ip,
        port: node.status_port,
      }
      map[display] = target
    })
    data.tikv?.nodes?.forEach((node) => {
      const display = `${node.ip}:${node.port}`
      const target = {
        kind: 'tikv',
        display_name: display,
        ip: node.ip,
        port: node.status_port,
      }
      map[display] = target
    })
    data.pd?.nodes?.forEach((node) => {
      const display = `${node.ip}:${node.port}`
      const target = {
        kind: 'pd',
        display_name: display,
        ip: node.ip,
        port: node.port,
      }
      map[display] = target
    })
    return map
  }, [data])
}

const profilingDurationsSec = [10, 30, 60, 120]
const defaultProfilingDuration = 30

export default function Page() {
  const targetsMap = useTargetsMap()

  // FIXME: Use Antd form
  const [selectedTargets, setSelectedTargets] = useState([])
  const [duration, setDuration] = useState(defaultProfilingDuration)

  const [submitting, setSubmitting] = useState(false)
  const {
    data: historyTable,
    isLoading: listLoading,
  } = useClientRequest((cancelToken) =>
    client.getInstance().getProfilingGroups({ cancelToken })
  )

  const { t } = useTranslation()
  const navigate = useNavigate()

  async function handleStart() {
    if (selectedTargets.length === 0) {
      // TODO: Show notification
      return
    }
    setSubmitting(true)
    const req = {
      targets: selectedTargets.map((k) => targetsMap[k]),
      duration_secs: duration,
    }
    try {
      const res = await client.getInstance().startProfiling(req)
      navigate(`/instance_profiling/${res.data.id}`)
    } catch (e) {
      // FIXME
      message.error(e.message)
    }
    setSubmitting(false)
  }

  const handleRowClick = usePersistFn(
    (rec, _idx, ev: React.MouseEvent<HTMLElement>) => {
      openLink(`/instance_profiling/${rec.id}`, ev, navigate)
    }
  )

  const historyTableColumns = [
    {
      name: t('instance_profiling.list.table.columns.targets'),
      key: 'targets',
      minWidth: 150,
      maxWidth: 250,
      onRender: (rec) => {
        // TODO: Extract to utility function
        const r: string[] = []
        if (rec.target_stats.num_tidb_nodes) {
          r.push(`${rec.target_stats.num_tidb_nodes} TiDB`)
        }
        if (rec.target_stats.num_tikv_nodes) {
          r.push(`${rec.target_stats.num_tikv_nodes} TiKV`)
        }
        if (rec.target_stats.num_pd_nodes) {
          r.push(`${rec.target_stats.num_pd_nodes} PD`)
        }
        return <span>{r.join(', ')}</span>
      },
    },
    {
      name: t('instance_profiling.list.table.columns.status'),
      key: 'status',
      minWidth: 100,
      maxWidth: 150,
      onRender: (rec) => {
        if (rec.state === 1) {
          return (
            <Badge
              status="processing"
              text={t('instance_profiling.list.table.status.running')}
            />
          )
        } else if (rec.state === 2) {
          return (
            <Badge
              status="success"
              text={t('instance_profiling.list.table.status.finished')}
            />
          )
        }
      },
    },
    {
      name: t('instance_profiling.list.table.columns.start_at'),
      key: 'started_at',
      minWidth: 160,
      maxWidth: 220,
      onRender: (rec) => {
        return <DateTime.Calendar unixTimestampMs={rec.started_at * 1000} />
      },
    },
    {
      name: t('instance_profiling.list.table.columns.duration'),
      key: 'duration',
      minWidth: 100,
      maxWidth: 150,
      fieldName: 'profile_duration_secs',
    },
  ]

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Card title={t('instance_profiling.list.control_form.title')}>
        <Form layout="inline">
          <Form.Item
            label={t('instance_profiling.list.control_form.nodes.label')}
          >
            <TreeSelect
              value={selectedTargets}
              treeData={getTreeData(targetsMap)}
              placeholder={t(
                'instance_profiling.list.control_form.nodes.placeholder'
              )}
              onChange={setSelectedTargets}
              treeDefaultExpandAll={true}
              treeCheckable={true}
              showCheckedStrategy={TreeSelect.SHOW_CHILD}
              allowClear
              filterTreeNode={filterTreeNode}
              style={{ width: 400 }}
            />
          </Form.Item>
          <Form.Item
            label={t('instance_profiling.list.control_form.duration.label')}
          >
            <Select
              value={duration}
              onChange={setDuration}
              style={{ width: 120 }}
            >
              {profilingDurationsSec.map((sec) => (
                <Select.Option value={sec} key={sec}>
                  {sec}s
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleStart} loading={submitting}>
              {t('instance_profiling.list.control_form.submit')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <div style={{ height: '100%', position: 'relative' }}>
        <ScrollablePane>
          <CardTableV2
            cardNoMarginTop
            loading={listLoading}
            items={historyTable || []}
            columns={historyTableColumns}
            onRowClicked={handleRowClick}
          />
        </ScrollablePane>
      </div>
    </div>
  )
}
