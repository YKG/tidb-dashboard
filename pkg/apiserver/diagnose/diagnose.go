// Copyright 2020 PingCAP, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// See the License for the specific language governing permissions and
// limitations under the License.

package diagnose

import (
	"encoding/json"
	"net/http"
	"time"

	assetfs "github.com/elazarl/go-bindata-assetfs"
	"github.com/gin-gonic/gin"
	"github.com/pingcap/log"
	"go.uber.org/zap"

	"github.com/pingcap-incubator/tidb-dashboard/pkg/apiserver/user"
	apiutils "github.com/pingcap-incubator/tidb-dashboard/pkg/apiserver/utils"
	"github.com/pingcap-incubator/tidb-dashboard/pkg/config"
	"github.com/pingcap-incubator/tidb-dashboard/pkg/dbstore"
	"github.com/pingcap-incubator/tidb-dashboard/pkg/tidb"
)

const (
	timeLayout = "2006-01-02 15:04:05"
)

type Service struct {
	config        *config.Config
	db            *dbstore.DB
	tidbForwarder *tidb.Forwarder
	uiAssetFS     *assetfs.AssetFS
}

func NewService(config *config.Config, tidbForwarder *tidb.Forwarder, db *dbstore.DB, uiAssetFS *assetfs.AssetFS) *Service {
	err := autoMigrate(db)
	if err != nil {
		log.Fatal("Failed to initialize database", zap.Error(err))
	}

	return &Service{
		config:        config,
		db:            db,
		tidbForwarder: tidbForwarder,
		uiAssetFS:     uiAssetFS,
	}
}

func Register(r *gin.RouterGroup, auth *user.AuthService, s *Service) {
	endpoint := r.Group("/diagnose")
	endpoint.GET("/reports",
		auth.MWAuthRequired(),
		s.reportsHandler)
	endpoint.POST("/reports",
		auth.MWAuthRequired(),
		apiutils.MWConnectTiDB(s.tidbForwarder),
		s.genReportHandler)
	endpoint.GET("/reports/:id/detail", s.reportHTMLHandler)
	endpoint.GET("/reports/:id/data.js", s.reportDataHandler)
	endpoint.GET("/reports/:id/status",
		auth.MWAuthRequired(),
		s.reportStatusHandler)
}

type GenerateReportRequest struct {
	StartTime        int64 `json:"start_time"`
	EndTime          int64 `json:"end_time"`
	CompareStartTime int64 `json:"compare_start_time"`
	CompareEndTime   int64 `json:"compare_end_time"`
}

// @Summary SQL diagnosis reports history
// @Description Get sql diagnosis reports history
// @Produce json
// @Success 200 {array} Report
// @Router /diagnose/reports [get]
// @Security JwtAuth
// @Failure 401 {object} utils.APIError "Unauthorized failure"
func (s *Service) reportsHandler(c *gin.Context) {
	reports, err := GetReports(s.db)
	if err != nil {
		_ = c.Error(err)
		return
	}
	c.JSON(http.StatusOK, reports)
}

// @Summary SQL diagnosis report
// @Description Generate sql diagnosis report
// @Produce json
// @Param request body GenerateReportRequest true "Request body"
// @Success 200 {object} int
// @Router /diagnose/reports [post]
// @Security JwtAuth
// @Failure 401 {object} utils.APIError "Unauthorized failure"
func (s *Service) genReportHandler(c *gin.Context) {
	var req GenerateReportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.Status(http.StatusBadRequest)
		_ = c.Error(apiutils.ErrInvalidRequest.WrapWithNoMessage(err))
		return
	}

	startTime := time.Unix(req.StartTime, 0)
	endTime := time.Unix(req.EndTime, 0)
	var compareStartTime, compareEndTime *time.Time
	if req.CompareStartTime != 0 && req.CompareEndTime != 0 {
		compareStartTime = new(time.Time)
		compareEndTime = new(time.Time)
		*compareStartTime = time.Unix(req.CompareStartTime, 0)
		*compareEndTime = time.Unix(req.CompareEndTime, 0)
	}

	reportID, err := NewReport(s.db, startTime, endTime, compareStartTime, compareEndTime)
	if err != nil {
		_ = c.Error(err)
		return
	}

	db := apiutils.TakeTiDBConnection(c)

	go func() {
		defer db.Close()

		var tables []*TableDef
		if compareStartTime == nil || compareEndTime == nil {
			tables = GetReportTablesForDisplay(startTime.Format(timeLayout), endTime.Format(timeLayout), db, s.db, reportID)
		} else {
			tables = GetCompareReportTablesForDisplay(
				compareStartTime.Format(timeLayout), compareEndTime.Format(timeLayout),
				startTime.Format(timeLayout), endTime.Format(timeLayout),
				db, s.db, reportID)
		}
		_ = UpdateReportProgress(s.db, reportID, 100)
		content, err := json.Marshal(tables)
		if err == nil {
			_ = SaveReportContent(s.db, reportID, string(content))
		}
	}()

	c.JSON(http.StatusOK, reportID)
}

// @Summary Diagnosis report status
// @Description Get diagnosis report status
// @Produce json
// @Param id path string true "report id"
// @Success 200 {object} Report
// @Router /diagnose/reports/{id}/status [get]
// @Security JwtAuth
// @Failure 401 {object} utils.APIError "Unauthorized failure"
func (s *Service) reportStatusHandler(c *gin.Context) {
	id := c.Param("id")
	report, err := GetReport(s.db, id)
	if err != nil {
		_ = c.Error(err)
		return
	}
	c.JSON(http.StatusOK, &report)
}

// @Summary SQL diagnosis report
// @Description Get sql diagnosis report HTML
// @Produce html
// @Param id path string true "report id"
// @Success 200 {string} string
// @Router /diagnose/reports/{id}/detail [get]
func (s *Service) reportHTMLHandler(c *gin.Context) {
	if s.uiAssetFS == nil {
		c.Data(http.StatusNotFound, "text/plain", []byte("UI is not built"))
		return
	}

	// Serve report html directly from assets
	d, err := s.uiAssetFS.Asset("build/diagnoseReport.html")
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	c.Data(http.StatusOK, "text/html; charset=utf-8", d)
}

// @Summary SQL diagnosis report data
// @Description Get sql diagnosis report data
// @Produce text/javascript
// @Param id path string true "report id"
// @Success 200 {string} string
// @Router /diagnose/reports/{id}/data.js [get]
func (s *Service) reportDataHandler(c *gin.Context) {
	id := c.Param("id")
	report, err := GetReport(s.db, id)
	if err != nil {
		_ = c.Error(err)
		return
	}

	data := "window.__diagnosis_data__ = " + report.Content
	c.Data(http.StatusOK, "text/javascript", []byte(data))
}
